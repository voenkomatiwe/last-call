"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { faucetCall, storageDepositCall } from "../contract/calls";
import { contractErrorCode, describeContractError } from "../contract/errors";
import { ContractReader } from "../contract/reader";
import type { ConfigView, StateView, StorageBalanceBounds } from "../contract/views";
import { formatLast, formatNear } from "../game/format";
import type { NearNetwork } from "../near/near-config";
import { createViewProvider } from "../near/view";
import { useWallet } from "../wallet/use-wallet";

// The testnet faucet page (LC-031): register → faucet() → back to the bar to join. The contract pays
// each account once (`faucet_used`, ERR_FAUCET_USED); the page only remembers a refusal so it can
// show it without another wallet round trip. There is no view for "already used".

interface Props {
  readonly network: NearNetwork;
  readonly contractId: string;
  readonly rpcUrl: string;
}

interface Snapshot {
  readonly config: ConfigView;
  readonly state: StateView;
  readonly bounds: StorageBalanceBounds;
  /** Undefined while no wallet is connected. */
  readonly account: { readonly registered: boolean; readonly balance: bigint } | undefined;
}

const usedKey = (contractId: string, accountId: string) => `lc-faucet-used:${contractId}:${accountId}`;

function readUsed(contractId: string, accountId: string): boolean {
  try {
    return window.localStorage.getItem(usedKey(contractId, accountId)) === "1";
  } catch {
    return false;
  }
}

function rememberUsed(contractId: string, accountId: string): void {
  try {
    window.localStorage.setItem(usedKey(contractId, accountId), "1");
  } catch {
    // Storage is a convenience; the contract still refuses a second claim.
  }
}

export function FaucetPanel({ network, contractId, rpcUrl }: Props) {
  const wallet = useWallet(network);
  const accountId = wallet.state.status === "connected" ? wallet.state.accountId : null;
  const reader = useMemo(() => new ContractReader(createViewProvider(rpcUrl), contractId), [rpcUrl, contractId]);
  const [data, setData] = useState<Snapshot | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | undefined>(undefined);
  const [used, setUsed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [config, state, bounds, account] = await Promise.all([
        reader.config(),
        reader.state(),
        reader.storageBalanceBounds(),
        accountId
          ? Promise.all([reader.storageBalance(accountId), reader.balance(accountId)]).then(([storage, balance]) => ({
              registered: storage !== null,
              balance,
            }))
          : Promise.resolve(undefined),
      ]);
      setData({ config, state, bounds, account });
      setLoadError(undefined);
    } catch (error) {
      setLoadError(describeContractError(error));
    }
  }, [reader, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setUsed(accountId ? readUsed(contractId, accountId) : false);
    setMessage(undefined);
  }, [accountId, contractId]);

  const send = useCallback(
    async (kind: "register" | "faucet") => {
      if (!data || !accountId) return;
      setBusy(true);
      setMessage(undefined);
      try {
        if (kind === "register") {
          await wallet.callContract(contractId, storageDepositCall(data.bounds.min));
          setMessage({ kind: "ok", text: "Registered for $LAST. Now claim from the faucet." });
        } else {
          await wallet.callContract(contractId, faucetCall());
          rememberUsed(contractId, accountId);
          setUsed(true);
          setMessage({
            kind: "ok",
            text: `Received ${formatLast(data.config.faucetAmount)}. Go back to the bar and join.`,
          });
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (contractErrorCode(text) === "ERR_FAUCET_USED") {
          rememberUsed(contractId, accountId);
          setUsed(true);
        }
        setMessage({ kind: "error", text: describeContractError(error) });
      } finally {
        setBusy(false);
        void load();
      }
    },
    [data, accountId, wallet, contractId, load]
  );

  if (loadError && !data) return <p role="alert">Could not read the contract: {loadError}</p>;
  if (!data) return <p>Loading…</p>;

  const { config, state, bounds, account } = data;
  const amount = config.faucetAmount;
  const claimsLeft = amount > 0n ? state.faucetLeft / amount : 0n;
  const enabled = amount > 0n && claimsLeft > 0n;

  return (
    <section className="lc-faucet">
      <dl>
        <dt>Contract</dt>
        <dd>
          <code>{contractId}</code>
        </dd>
        <dt>Per account</dt>
        <dd>{amount > 0n ? `${formatLast(amount)}, once` : "Faucet is off on this deployment"}</dd>
        <dt>Left</dt>
        <dd>
          {formatLast(state.faucetLeft)} (about {claimsLeft.toString()} claims)
        </dd>
        <dt>Join stake</dt>
        <dd>
          {formatLast(config.joinStake)} + {formatNear(config.memberStorageDeposit)} storage
        </dd>
      </dl>

      <ol>
        <li>
          Register for $LAST (<code>storage_deposit</code>, {formatNear(bounds.min)}).
        </li>
        <li>
          Claim from the faucet (<code>faucet()</code>, once per account).
        </li>
        <li>
          Back in the <a href="/">bar</a>, join with {formatNear(config.memberStorageDeposit)} attached.
        </li>
      </ol>
      <p>Every step is a transaction, so the account needs a little testnet NEAR for gas and deposits.</p>

      {wallet.state.status === "loading" ? (
        <p>Checking the wallet…</p>
      ) : !accountId ? (
        <button type="button" onClick={() => void wallet.connect()}>
          Connect a testnet wallet
        </button>
      ) : (
        <div>
          <p>
            Connected as <code>{accountId}</code>
            {account ? `, balance ${formatLast(account.balance)}` : ""}.{" "}
            <button type="button" onClick={() => void wallet.disconnect()}>
              Disconnect
            </button>
          </p>
          {!account ? null : !account.registered ? (
            <button type="button" disabled={busy} onClick={() => void send("register")}>
              1. Register for $LAST
            </button>
          ) : used ? (
            <p>
              This account already used the faucet. <a href="/">Go to the bar</a>.
            </p>
          ) : (
            <button type="button" disabled={busy || !enabled} onClick={() => void send("faucet")}>
              2. Get {formatLast(amount)}
            </button>
          )}
        </div>
      )}

      {message ? <p role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}
