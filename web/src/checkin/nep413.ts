import { isValidAccountId } from "../near/account-id";
import { base58ToBytes, bytesToBase58 } from "../near/encoding";

// NEP-413 signed messages, as the contract verifies them in `check_in_signed` (plan section 4.10).
// Specification: https://github.com/near/NEPs/blob/master/neps/nep-0413.md

/** The NEP-413 prefix tag: 2^31 + 413. */
export const NEP413_TAG = 2_147_484_061;

export const NEP413_NONCE_LENGTH = 32;
const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;
const ED25519_KEY_PREFIX = "ed25519:";
const MAX_DAY = 0xffff_ffff;

export interface Nep413Payload {
  readonly message: string;
  readonly nonce: Uint8Array;
  readonly recipient: string;
  readonly callbackUrl?: string;
}

/**
 * The exact message the contract rebuilds from `account_id` and `day`. It is built by hand, not with
 * `JSON.stringify`, because the signature covers these bytes: key order and spacing must not change.
 */
export function checkInMessage(accountId: string, day: number): string {
  if (!isValidAccountId(accountId)) throw new Error(`Invalid account ID: ${accountId}`);
  if (!Number.isInteger(day) || day < 0 || day > MAX_DAY) throw new Error(`Invalid day: ${day}`);
  return `{"action":"check_in","account_id":"${accountId}","day":${day}}`;
}

/** The payload a wallet must sign for a check-in. The contract expects no callback URL. */
export function checkInPayload(input: {
  readonly accountId: string;
  readonly day: number;
  readonly nonce: Uint8Array;
  readonly contractId: string;
}): Nep413Payload {
  if (!isValidAccountId(input.contractId)) throw new Error(`Invalid contract ID: ${input.contractId}`);
  return {
    message: checkInMessage(input.accountId, input.day),
    nonce: input.nonce,
    recipient: input.contractId,
  };
}

export function createNonce(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(NEP413_NONCE_LENGTH));
}

function u32LittleEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function borshString(value: string): Uint8Array[] {
  const utf8 = new TextEncoder().encode(value);
  return [u32LittleEndian(utf8.length), utf8];
}

/** Borsh bytes of the tag followed by the payload: the input of the SHA-256 hash that gets signed. */
export function serializeNep413Payload(payload: Nep413Payload): Uint8Array<ArrayBuffer> {
  if (payload.nonce.length !== NEP413_NONCE_LENGTH) {
    throw new Error(`The nonce must be ${NEP413_NONCE_LENGTH} bytes, got ${payload.nonce.length}`);
  }

  const parts = [
    u32LittleEndian(NEP413_TAG),
    ...borshString(payload.message),
    payload.nonce,
    ...borshString(payload.recipient),
    ...(payload.callbackUrl === undefined
      ? [Uint8Array.of(0)]
      : [Uint8Array.of(1), ...borshString(payload.callbackUrl)]),
  ];

  const serialized = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    serialized.set(part, offset);
    offset += part.length;
  }
  return serialized;
}

/** The 32-byte SHA-256 hash that the wallet signs and the contract verifies. */
export async function hashNep413Payload(payload: Nep413Payload): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", serializeNep413Payload(payload)));
}

/** Parses `ed25519:<base58>` into the 32 raw key bytes. Other curves are rejected, as in the contract. */
export function parseEd25519PublicKey(publicKey: string): Uint8Array<ArrayBuffer> {
  if (!publicKey.startsWith(ED25519_KEY_PREFIX)) throw new Error("The public key must start with ed25519:");
  const bytes = base58ToBytes(publicKey.slice(ED25519_KEY_PREFIX.length));
  if (bytes.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(`An ed25519 public key must be ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function formatEd25519PublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(`An ed25519 public key must be ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`);
  }
  return ED25519_KEY_PREFIX + bytesToBase58(publicKey);
}

/**
 * Checks an ed25519 signature over the payload hash. Returns false for a wrong or malformed
 * signature or key; it throws only when the payload itself cannot be serialized.
 */
export async function verifyNep413Signature(input: {
  readonly payload: Nep413Payload;
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
}): Promise<boolean> {
  const hash = await hashNep413Payload(input.payload);
  if (input.signature.length !== ED25519_SIGNATURE_LENGTH) return false;
  if (input.publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) return false;

  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(input.publicKey), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, Uint8Array.from(input.signature), hash);
  } catch {
    // WebCrypto rejects some malformed keys by throwing instead of returning false.
    return false;
  }
}
