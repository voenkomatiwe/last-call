import { isValidAccountId } from "../near/account-id";
import { base58ToBytes, base64ToBytes } from "../near/encoding";

// Change calls of the contract: method, arguments, gas, and attached deposit, as `contract/API.md`
// ("Change methods", "Token and storage standards") requires. The shape is the one wallets and
// near-api-js take for a function call; amounts are decimal strings.

export interface ContractCall {
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  /** Gas in gas units, decimal string. Unused gas is refunded. */
  readonly gas: string;
  /** Attached deposit in yoctoNEAR, decimal string. */
  readonly deposit: string;
}

const TGAS = 1_000_000_000_000n;

/**
 * Gas limits per call, from the measured figures in `API.md` with room to spare: game calls may
 * auto-settle up to 50 days (15.5 Tgas burnt) and must keep 15 Tgas for the hero draw.
 */
export const GAS = {
  game: (100n * TGAS).toString(),
  checkInSigned: (50n * TGAS).toString(),
  settle: (300n * TGAS).toString(),
  retryPickHero: (100n * TGAS).toString(),
  light: (30n * TGAS).toString(),
} as const;

/** Exactly 1 yoctoNEAR, required by `claim`, `leave`, `set_checkin_key`, and `storage_withdraw`. */
export const ONE_YOCTO = "1";
const NO_DEPOSIT = "0";

function accountId(value: string, name: string): string {
  if (!isValidAccountId(value)) throw new Error(`${name} is not a valid NEAR account ID: ${value}`);
  return value;
}

/** near-sdk accepts any `ed25519:<base58>` that decodes to 32 bytes; leading zero bytes shorten it. */
function checkinKey(key: string | null): string | null {
  if (key === null) return null;
  let bytes: Uint8Array | undefined;
  if (key.startsWith("ed25519:")) {
    try {
      bytes = base58ToBytes(key.slice("ed25519:".length));
    } catch {
      bytes = undefined;
    }
  }
  if (bytes?.length !== 32) throw new Error(`The check-in key must be "ed25519:<base58 of 32 bytes>", got: ${key}`);
  return key;
}

function day(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`Invalid day: ${value}`);
  return value;
}

function base64OfLength(value: string, length: number, name: string): string {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error(`${name} is not base64`);
  }
  if (bytes.length !== length) throw new Error(`${name} must be ${length} bytes, got ${bytes.length}`);
  return value;
}

function positiveAmount(value: bigint, name: string): string {
  if (value <= 0n) throw new Error(`${name} must be positive`);
  return value.toString();
}

/** Registers the signer for the token. Attach `storage_balance_bounds().min`. */
export function storageDepositCall(minDeposit: bigint): ContractCall {
  return {
    methodName: "storage_deposit",
    args: { account_id: null, registration_only: true },
    gas: GAS.light,
    deposit: positiveAmount(minDeposit, "The storage deposit"),
  };
}

/** One faucet claim per account (demo set only). */
export function faucetCall(): ContractCall {
  return { methodName: "faucet", args: {}, gas: GAS.light, deposit: NO_DEPOSIT };
}

/** Joins with `join_stake` LAST. Attach `member_storage_deposit`; the surplus is refunded. */
export function joinCall(memberStorageDeposit: bigint, key: string | null = null): ContractCall {
  return {
    methodName: "join",
    args: { checkin_key: checkinKey(key) },
    gas: GAS.game,
    deposit: positiveAmount(memberStorageDeposit, "The member storage deposit"),
  };
}

export function checkInCall(): ContractCall {
  return { methodName: "check_in", args: {}, gas: GAS.game, deposit: NO_DEPOSIT };
}

/** `nonce` and `signature` are base64 of 32 and 64 bytes. Anyone may send it; no deposit. */
export function checkInSignedCall(input: {
  readonly accountId: string;
  readonly day: number;
  readonly nonceBase64: string;
  readonly signatureBase64: string;
}): ContractCall {
  return {
    methodName: "check_in_signed",
    args: {
      account_id: accountId(input.accountId, "account_id"),
      day: day(input.day),
      nonce: base64OfLength(input.nonceBase64, 32, "nonce"),
      signature: base64OfLength(input.signatureBase64, 64, "signature"),
    },
    gas: GAS.checkInSigned,
    deposit: NO_DEPOSIT,
  };
}

export function setCheckinKeyCall(key: string | null): ContractCall {
  return { methodName: "set_checkin_key", args: { key: checkinKey(key) }, gas: GAS.light, deposit: ONE_YOCTO };
}

export function claimCall(): ContractCall {
  return { methodName: "claim", args: {}, gas: GAS.game, deposit: ONE_YOCTO };
}

export function leaveCall(): ContractCall {
  return { methodName: "leave", args: {}, gas: GAS.game, deposit: ONE_YOCTO };
}

export function kickCall(target: string): ContractCall {
  return {
    methodName: "kick",
    args: { account_id: accountId(target, "The kick target") },
    gas: GAS.game,
    deposit: NO_DEPOSIT,
  };
}

/** Closes up to `maxDays` finished days (contract default and maximum: 500). */
export function settleCall(maxDays: number | null = null): ContractCall {
  if (maxDays !== null && (!Number.isInteger(maxDays) || maxDays < 1)) {
    throw new Error(`max_days must be a positive integer, got: ${maxDays}`);
  }
  return { methodName: "settle", args: { max_days: maxDays }, gas: GAS.settle, deposit: NO_DEPOSIT };
}

export function retryPickHeroCall(dayNumber: number): ContractCall {
  return { methodName: "retry_pick_hero", args: { day: day(dayNumber) }, gas: GAS.retryPickHero, deposit: NO_DEPOSIT };
}
