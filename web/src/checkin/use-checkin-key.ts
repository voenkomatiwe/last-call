"use client";

import { Account } from "near-api-js";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createViewProvider } from "../near/view";
import {
  checkinKeyStatus,
  enableCheckinKeyActions,
  isAllowanceExhausted,
  keyCheckInCall,
  type OwnAccountAction,
} from "./access-key";
import { generateCheckinKey, type KeyStore, keyId, publicKeyString, supportsBrowserKeys } from "./browser-key";
import { IndexedDbKeyStore } from "./indexeddb-key-store";
import { WebCryptoSigner } from "./webcrypto-signer";

// One-tap check-in for the connected member: a non-extractable key in this browser that is a
// check_in-only access key of the member's own account (plan decision "12.11 (поздно ночью)").

export type QuickStatus =
  /** Still reading the browser and the chain. */
  | "loading"
  /** No WebCrypto Ed25519 or IndexedDB here: only the wallet check-in. */
  | "unsupported"
  /** No usable key: none in this browser, not on the account, or its allowance is used up. */
  | "off"
  | "ready";

export interface QuickCheckIn {
  readonly status: QuickStatus;
  /** Creates a key and asks the wallet to add it (replacing a used-up one) in one confirmation. */
  readonly enable: () => Promise<void>;
  /** Signs and sends `check_in` from the account with the browser key; returns the method's result. */
  readonly checkIn: () => Promise<unknown>;
}

export function useCheckinKey(input: {
  readonly rpcUrl: string;
  readonly contractId: string;
  readonly accountId: string | null;
  /** Sends wallet actions to the member's own account. */
  readonly sendActions: (receiverId: string, actions: readonly OwnAccountAction[]) => Promise<unknown>;
}): QuickCheckIn {
  const { rpcUrl, contractId, accountId, sendActions } = input;
  const provider = useMemo(() => createViewProvider(rpcUrl), [rpcUrl]);
  const [store] = useState<KeyStore | undefined>(() =>
    typeof indexedDB === "undefined" ? undefined : new IndexedDbKeyStore()
  );
  const [status, setStatus] = useState<QuickStatus>("loading");
  const [pair, setPair] = useState<CryptoKeyPair | undefined>(undefined);
  /** Public key whose allowance ran out: replaced on the next enable. */
  const [exhausted, setExhausted] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads after enable.
  useEffect(() => {
    let active = true;
    // Never show the previous account's key while the new account is being read.
    setStatus("loading");
    setPair(undefined);
    (async () => {
      if (!accountId) return setStatus("off");
      if (!store || !(await supportsBrowserKeys())) return active && setStatus("unsupported");
      const loaded = await store.load(keyId(contractId, accountId));
      if (!active) return;
      setPair(loaded);
      if (!loaded) return setStatus("off");
      const publicKey = await publicKeyString(loaded);
      const onChain = await checkinKeyStatus(provider, accountId, publicKey, contractId);
      if (active) setStatus(onChain === "ready" && publicKey !== exhausted ? "ready" : "off");
    })().catch(() => active && setStatus("off"));
    return () => {
      active = false;
    };
  }, [accountId, contractId, provider, store, tick]);

  const enable = useCallback(async () => {
    if (!accountId || !store) throw new Error("Connect a wallet first");
    const id = keyId(contractId, accountId);
    const current = await store.load(id);
    const currentKey = current ? await publicKeyString(current) : null;
    // Reuse a local key the account does not have yet; otherwise make a new one and remove the old
    // check-in key (for example one with a used-up allowance) in the same transaction.
    const reuse =
      current && currentKey !== exhausted
        ? (await checkinKeyStatus(provider, accountId, currentKey as string, contractId)) === "missing"
        : false;
    const next = reuse && current ? current : await generateCheckinKey();
    const nextKey = await publicKeyString(next);
    const previous = !reuse && currentKey ? currentKey : null;
    const onChainPrevious =
      previous && (await checkinKeyStatus(provider, accountId, previous, contractId)) !== "missing" ? previous : null;
    await sendActions(accountId, enableCheckinKeyActions(contractId, nextKey, onChainPrevious));
    await store.save(id, next);
    setExhausted(null);
    setTick((value) => value + 1);
  }, [accountId, contractId, exhausted, provider, sendActions, store]);

  const checkIn = useCallback(async () => {
    if (!accountId || !pair) throw new Error("One-tap check-in is not enabled");
    const account = new Account(accountId, provider, new WebCryptoSigner(pair));
    const call = keyCheckInCall();
    try {
      return await account.callFunction({
        contractId,
        methodName: call.methodName,
        args: call.args,
        gas: BigInt(call.gas),
        deposit: 0n,
      });
    } catch (error) {
      if (isAllowanceExhausted(error)) {
        setExhausted(await publicKeyString(pair));
        setTick((value) => value + 1);
        throw new Error(
          "The one-tap key has used its gas allowance. Check in with the wallet, or enable one-tap check-in again."
        );
      }
      throw error;
    }
  }, [accountId, contractId, pair, provider]);

  return { status, enable, checkIn };
}
