import type { JsonRpcProvider } from "near-api-js";
import { AccessKeyNotEnoughAllowanceActionError } from "near-api-js/rpc-errors";

import type { ContractCall } from "../contract/calls";

// The member's own function-call access key for one-tap check-ins (plan decision
// "12.11 (поздно ночью)"): limited to the Last Call contract and `check_in`, so it cannot move funds
// or call anything else. The member's account pays the gas; the platform pays nothing.

const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;

/**
 * Gas for a check-in sent with the key. The allowance is charged the prepaid gas and refunds do
 * not restore it, so this is kept below the 100 Tgas of a wallet call: API.md measured 1.3–15.5 Tgas
 * burnt (with 50 days of auto-settle) and the call needs 15 Tgas left for a hero draw.
 */
export const KEY_CHECK_IN_GAS = 50n * TGAS;

/** Lifetime gas allowance of the key: about 200 check-ins at 50 Tgas; actual spend is far lower. */
export const KEY_ALLOWANCE = 1n * NEAR;

export const KEY_METHODS = ["check_in"] as const;

/** `check_in` with the key's gas. */
export function keyCheckInCall(): ContractCall {
  return { methodName: "check_in", args: {}, gas: KEY_CHECK_IN_GAS.toString(), deposit: "0" };
}

/** The wallet action (near-connect `AddKey`) the member signs once, sent to their own account. */
export interface AddCheckinKeyAction {
  readonly type: "AddKey";
  readonly params: {
    readonly publicKey: string;
    readonly accessKey: {
      readonly permission: { readonly receiverId: string; readonly allowance: string; readonly methodNames: string[] };
    };
  };
}

export interface DeleteKeyAction {
  readonly type: "DeleteKey";
  readonly params: { readonly publicKey: string };
}

/** The wallet actions this page ever sends to the member's own account. */
export type OwnAccountAction = AddCheckinKeyAction | DeleteKeyAction;

/**
 * Actions that install `publicKey` as the check-in key, removing a previous check-in key in the
 * same transaction (for example one whose allowance ran out) so keys do not pile up.
 */
export function enableCheckinKeyActions(
  contractId: string,
  publicKey: string,
  previousKey: string | null = null
): OwnAccountAction[] {
  const add = addCheckinKeyAction(contractId, publicKey);
  return previousKey && previousKey !== publicKey
    ? [{ type: "DeleteKey", params: { publicKey: previousKey } }, add]
    : [add];
}

/**
 * True when the key's lifetime gas allowance is used up. Matched by class and by message: a
 * production build renames classes, so the class name itself must not be relied on.
 */
export function isAllowanceExhausted(error: unknown): boolean {
  if (error instanceof AccessKeyNotEnoughAllowanceActionError) return true;
  const text = error instanceof Error ? `${error.message}` : String(error);
  return /not enough allowance|NotEnoughAllowance/i.test(text);
}

export function addCheckinKeyAction(contractId: string, publicKey: string): AddCheckinKeyAction {
  return {
    type: "AddKey",
    params: {
      publicKey,
      accessKey: {
        permission: { receiverId: contractId, allowance: KEY_ALLOWANCE.toString(), methodNames: [...KEY_METHODS] },
      },
    },
  };
}

export type KeyStatus = "ready" | "missing" | "wrong-permission";

/**
 * Whether `publicKey` is on the account as a check_in key for `contractId`. A key with any other
 * permission (full access included) is reported as `wrong-permission` and is not used.
 */
export function keyStatusFromView(view: unknown, contractId: string): KeyStatus {
  const permission = (view as { permission?: unknown } | null)?.permission;
  const call = (permission as { FunctionCall?: { receiver_id?: unknown; method_names?: unknown } } | null)
    ?.FunctionCall;
  if (!call) return "wrong-permission";
  const methods = Array.isArray(call.method_names) ? call.method_names : [];
  return call.receiver_id === contractId && methods.length === 1 && methods[0] === "check_in"
    ? "ready"
    : "wrong-permission";
}

export async function checkinKeyStatus(
  provider: JsonRpcProvider,
  accountId: string,
  publicKey: string,
  contractId: string
): Promise<KeyStatus> {
  try {
    return keyStatusFromView(await provider.viewAccessKey({ accountId, publicKey }), contractId);
  } catch (error) {
    // The RPC reports a key that is not on the account as an error.
    if (/does not exist|AccessKeyDoesNotExist|UNKNOWN_ACCESS_KEY/i.test(String(error))) return "missing";
    throw error;
  }
}
