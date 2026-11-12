import { base64ToBytes } from "../near/encoding";

// Interprets the `FinalExecutionOutcome` a wallet returns after `signAndSendTransaction`. It comes
// from the wallet, so it is untrusted: only the documented RPC shape is read
// (`status: { SuccessValue: base64 } | { Failure: ... }`).

export class TransactionFailedError extends Error {
  override readonly name = "TransactionFailedError";
}

/**
 * Returns the JSON value the called method returned (`undefined` for a method that returns
 * nothing). Throws `TransactionFailedError` with the failure text, which carries the contract's
 * `ERR_*` code when the contract panicked.
 */
export function transactionResult(outcome: unknown): unknown {
  const status = (outcome as { status?: unknown } | null)?.status;
  if (typeof status !== "object" || status === null) {
    throw new TransactionFailedError(`The wallet returned no final status: ${JSON.stringify(status)}`);
  }
  if ("Failure" in status) {
    throw new TransactionFailedError(`Transaction failed: ${JSON.stringify((status as { Failure: unknown }).Failure)}`);
  }
  if (!("SuccessValue" in status)) {
    throw new TransactionFailedError(`Unexpected transaction status: ${JSON.stringify(status)}`);
  }
  const value = (status as { SuccessValue: unknown }).SuccessValue;
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new TransactionFailedError("SuccessValue is not base64");
  const text = new TextDecoder().decode(base64ToBytes(value));
  try {
    return JSON.parse(text);
  } catch {
    throw new TransactionFailedError(`The method returned non-JSON: ${text.slice(0, 80)}`);
  }
}
