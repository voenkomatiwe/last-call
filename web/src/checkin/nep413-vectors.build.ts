// Builds the NEP-413 check-in test vectors for the contract tests.
// Regenerate with: bun web/src/checkin/nep413-vectors.build.ts
//
// The signatures come from near-api-js, an implementation independent of `nep413.ts`. The key is
// the public test key of RFC 8032 section 7.1 (test 1); it must never hold funds.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { KeyPairSigner } from "near-api-js";

import { bytesToBase58, bytesToBase64, bytesToHex, hexToBytes } from "../near/encoding";
import { checkInPayload, formatEd25519PublicKey, hashNep413Payload, serializeNep413Payload } from "./nep413";

export const RFC8032_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
export const RFC8032_PUBLIC_KEY_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

interface VectorInput {
  readonly name: string;
  readonly expected: "valid" | "invalid";
  readonly accountId: string;
  readonly day: number;
  readonly contractId: string;
  readonly nonce: Uint8Array;
  readonly callbackUrl?: string;
}

const sequentialNonce = Uint8Array.from({ length: 32 }, (_, index) => index);

const VECTOR_INPUTS: readonly VectorInput[] = [
  {
    name: "check-in signed without a callback URL",
    expected: "valid",
    accountId: "alice.testnet",
    day: 7,
    contractId: "lastcall.testnet",
    nonce: sequentialNonce,
  },
  {
    name: "day 0, implicit account, sandbox contract",
    expected: "valid",
    accountId: RFC8032_PUBLIC_KEY_HEX,
    day: 0,
    contractId: "lastcall.test.near",
    nonce: new Uint8Array(32).fill(255),
  },
  {
    name: "wallet added a callback URL to the payload: the contract rebuilds the payload without it and must reject",
    expected: "invalid",
    accountId: "alice.testnet",
    day: 7,
    contractId: "lastcall.testnet",
    nonce: sequentialNonce,
    callbackUrl: "https://lastcall.example/",
  },
];

export async function buildVectors() {
  const seed = hexToBytes(RFC8032_SEED_HEX);
  const publicKey = hexToBytes(RFC8032_PUBLIC_KEY_HEX);
  // NEAR secret key strings are base58(seed || public key).
  const signer = KeyPairSigner.fromSecretKey(`ed25519:${bytesToBase58(Uint8Array.from([...seed, ...publicKey]))}`);

  const vectors = [];
  for (const input of VECTOR_INPUTS) {
    const base = checkInPayload(input);
    const signedPayload = input.callbackUrl === undefined ? base : { ...base, callbackUrl: input.callbackUrl };
    const signed = await signer.signNep413Message(input.accountId, {
      message: signedPayload.message,
      recipient: signedPayload.recipient,
      nonce: signedPayload.nonce,
      ...(input.callbackUrl === undefined ? {} : { callbackUrl: input.callbackUrl }),
    });

    vectors.push({
      name: input.name,
      expected: input.expected,
      account_id: input.accountId,
      day: input.day,
      recipient: input.contractId,
      nonce_base64: bytesToBase64(input.nonce),
      nonce_hex: bytesToHex(input.nonce),
      signed_callback_url: input.callbackUrl ?? null,
      message: signedPayload.message,
      signed_payload_hex: bytesToHex(serializeNep413Payload(signedPayload)),
      signed_hash_hex: bytesToHex(await hashNep413Payload(signedPayload)),
      signature_base64: bytesToBase64(signed.signature),
      signature_hex: bytesToHex(signed.signature),
    });
  }

  return {
    description:
      "NEP-413 check-in vectors for check_in_signed. Call it with account_id, day, nonce_base64, signature_base64 while current_account_id == recipient, today == day, and the member's checkin_key == key.public_key. 'valid' vectors must pass; 'invalid' vectors must fail with ERR_BAD_SIGNATURE. signed_payload_hex and signed_hash_hex are what the signer actually signed; for 'valid' vectors they equal what the contract must rebuild.",
    key: {
      source: "RFC 8032 section 7.1, test 1. Public test key: never fund it.",
      seed_hex: RFC8032_SEED_HEX,
      public_key_hex: RFC8032_PUBLIC_KEY_HEX,
      public_key: formatEd25519PublicKey(publicKey),
    },
    vectors,
  };
}

export const VECTORS_FILE = path.join(import.meta.dirname, "nep413-vectors.json");

if (import.meta.main) {
  await writeFile(VECTORS_FILE, `${JSON.stringify(await buildVectors(), null, 2)}\n`);
  console.info(`Wrote ${VECTORS_FILE}`);
}
