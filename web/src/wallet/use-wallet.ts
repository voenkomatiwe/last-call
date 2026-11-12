"use client";

import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ContractCall } from "../contract/calls";
import type { NearNetwork } from "../near/near-config";
import { transactionResult } from "./outcome";

export type WalletState =
  | { readonly status: "loading" }
  | { readonly status: "disconnected" }
  | { readonly status: "connected"; readonly accountId: string; readonly walletName: string };

export interface SignedWalletMessage {
  readonly accountId: string;
  readonly publicKey: string;
  readonly signature: string;
}

interface Connection {
  readonly connector: NearConnector;
  wallet: NearWalletBase | undefined;
}

function connectedState(wallet: NearWalletBase, accounts: ReadonlyArray<{ accountId: string }>): WalletState {
  const accountId = accounts[0]?.accountId;
  return accountId ? { status: "connected", accountId, walletName: wallet.manifest.name } : { status: "disconnected" };
}

/**
 * Wallet connection through near-connect. The library is imported inside an effect because it uses
 * `window` and IndexedDB, which do not exist while the component renders on the server.
 */
export function useWallet(network: NearNetwork) {
  const connection = useRef<Connection | undefined>(undefined);
  const [state, setState] = useState<WalletState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let connector: NearConnector | undefined;

    (async () => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (!active) return;

      // Only wallets that can sign NEP-413 messages and send transactions on this network are offered.
      connector = new NearConnector({
        network,
        features: { signMessage: true, signAndSendTransaction: true, [network]: true },
      });
      const current: Connection = { connector, wallet: undefined };
      connection.current = current;

      connector.on("wallet:signIn", ({ wallet, accounts }) => {
        current.wallet = wallet;
        setState(connectedState(wallet, accounts));
      });
      connector.on("wallet:signOut", () => {
        current.wallet = undefined;
        setState({ status: "disconnected" });
      });

      try {
        const { wallet, accounts } = await connector.getConnectedWallet();
        if (!active) return;
        current.wallet = wallet;
        setState(connectedState(wallet, accounts));
      } catch {
        // near-connect rejects when no wallet was connected in an earlier visit.
        if (active) setState({ status: "disconnected" });
      }
    })();

    return () => {
      active = false;
      connector?.removeAllListeners();
      connection.current = undefined;
    };
  }, [network]);

  const connect = useCallback(async () => {
    await connection.current?.connector.connect();
  }, []);

  const disconnect = useCallback(async () => {
    await connection.current?.connector.disconnect();
  }, []);

  const signMessage = useCallback(
    async (params: { message: string; recipient: string; nonce: Uint8Array }): Promise<SignedWalletMessage> => {
      const wallet = connection.current?.wallet;
      if (!wallet) throw new Error("No wallet is connected");
      const signed = await wallet.signMessage(params);
      return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
    },
    []
  );

  /** Sends one function call from the connected account and returns the method's JSON result. */
  const callContract = useCallback(async (contractId: string, call: ContractCall): Promise<unknown> => {
    const wallet = connection.current?.wallet;
    if (!wallet) throw new Error("No wallet is connected");
    const outcome = await wallet.signAndSendTransaction({
      receiverId: contractId,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: call.methodName, args: call.args, gas: call.gas, deposit: call.deposit },
        },
      ],
    });
    return transactionResult(outcome);
  }, []);

  return { state, connect, disconnect, signMessage, callContract };
}
