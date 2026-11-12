"use client";

import { useState } from "react";

import { checkInPayload, createNonce } from "../checkin/nep413";
import { bytesToBase64 } from "../near/encoding";
import type { NearNetwork } from "../near/near-config";
import { diagnoseSignedMessage, type SignatureDiagnosis } from "./signature-diagnosis";
import { useWallet } from "./use-wallet";

interface Report {
  readonly diagnosis: SignatureDiagnosis;
  readonly raw: Record<string, unknown>;
}

const TEST_DAY = 0;

function explain(diagnosis: SignatureDiagnosis): string {
  switch (diagnosis.verdict) {
    case "matches-contract":
      return diagnosis.signatureEncoding === "base64"
        ? "The contract would accept this signature."
        : "The signature is valid, but the wallet returned it in base58. It must be converted to base64 before it is sent to the contract.";
    case "signed-with-callback-url":
      return `The wallet added a callback URL (${diagnosis.callbackUrl}) to the signed payload. The contract rebuilds the payload without one and would reject this signature.`;
    case "no-match":
      return "The signature is well formed but matches none of the payloads tried here. The wallet signs something other than the NEP-413 payload we expect.";
    case "malformed":
      return `The wallet's answer could not be decoded: ${diagnosis.problem}`;
    case "unsupported-runtime":
      return "This browser cannot verify ed25519 signatures, so nothing can be concluded. Try a current Chrome, Firefox, or Safari.";
  }
}

export function WalletDiagnostics({
  network,
  recipient,
}: {
  readonly network: NearNetwork;
  readonly recipient: string;
}) {
  const { state, connect, disconnect, signMessage } = useWallet(network);
  const [report, setReport] = useState<Report | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function signTestCheckIn(accountId: string, walletName: string) {
    setReport(undefined);
    const nonce = createNonce();
    const payload = checkInPayload({ accountId, day: TEST_DAY, nonce, contractId: recipient });
    const signed = await signMessage({ message: payload.message, recipient: payload.recipient, nonce });
    const callbackUrlCandidates = [window.location.href, window.location.origin, `${window.location.origin}/`];
    const diagnosis = await diagnoseSignedMessage({
      payload,
      publicKey: signed.publicKey,
      signature: signed.signature,
      callbackUrlCandidates,
    });

    setReport({
      diagnosis,
      raw: {
        wallet: walletName,
        network,
        connected_account_id: accountId,
        message: payload.message,
        recipient: payload.recipient,
        nonce_base64: bytesToBase64(nonce),
        returned_account_id: signed.accountId,
        returned_public_key: signed.publicKey,
        returned_signature: signed.signature,
        callback_url_candidates: callbackUrlCandidates,
        diagnosis,
      },
    });
  }

  return (
    <section>
      <p>
        Network: <code>{network}</code>. Message recipient: <code>{recipient}</code>.
      </p>

      {state.status === "loading" && <p>Loading wallets…</p>}

      {state.status === "disconnected" && (
        <button disabled={busy} onClick={() => run(connect)} type="button">
          Connect wallet
        </button>
      )}

      {state.status === "connected" && (
        <>
          <p>
            Connected: <code>{state.accountId}</code> through {state.walletName}.
          </p>
          <p>
            <button
              disabled={busy}
              onClick={() => run(() => signTestCheckIn(state.accountId, state.walletName))}
              type="button"
            >
              Sign a test check-in
            </button>{" "}
            <button disabled={busy} onClick={() => run(disconnect)} type="button">
              Disconnect
            </button>
          </p>
          <p>
            Signing costs nothing and sends no transaction. The test message is a check-in for day {TEST_DAY}; it is
            only verified on this page.
          </p>
        </>
      )}

      {error && <p role="alert">Error: {error}</p>}

      {report && (
        <>
          <h2>Result: {report.diagnosis.verdict}</h2>
          <p>{explain(report.diagnosis)}</p>
          <h3>Raw values</h3>
          <pre style={{ overflowX: "auto" }}>{JSON.stringify(report.raw, null, 2)}</pre>
        </>
      )}
    </section>
  );
}
