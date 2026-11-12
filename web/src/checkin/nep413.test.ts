import { describe, expect, test } from "bun:test";

import { KeyPairSigner } from "near-api-js";

import { base64ToBytes, bytesToBase58, bytesToHex, hexToBytes } from "../near/encoding";
import {
  checkInMessage,
  checkInPayload,
  createNonce,
  formatEd25519PublicKey,
  hashNep413Payload,
  type Nep413Payload,
  parseEd25519PublicKey,
  serializeNep413Payload,
  verifyNep413Signature,
} from "./nep413";
import { buildVectors, RFC8032_PUBLIC_KEY_HEX, RFC8032_SEED_HEX } from "./nep413-vectors.build";
import vectorsFile from "./nep413-vectors.json";

const publicKey = hexToBytes(RFC8032_PUBLIC_KEY_HEX);
const [validVector, , callbackVector] = vectorsFile.vectors;
if (!validVector || !callbackVector) throw new Error("The vector file is missing vectors");

const validPayload = checkInPayload({
  accountId: validVector.account_id,
  day: validVector.day,
  nonce: hexToBytes(validVector.nonce_hex),
  contractId: validVector.recipient,
});
const validSignature = base64ToBytes(validVector.signature_base64);

function verify(payload: Nep413Payload, signature = validSignature, key: Uint8Array = publicKey) {
  return verifyNep413Signature({ payload, signature, publicKey: key });
}

describe("checkInMessage", () => {
  test("is the exact string the contract rebuilds", () => {
    expect(checkInMessage("alice.testnet", 7)).toBe('{"action":"check_in","account_id":"alice.testnet","day":7}');
    expect(checkInMessage("a-b_c.near", 4294967295)).toBe(
      '{"action":"check_in","account_id":"a-b_c.near","day":4294967295}'
    );
  });

  test("rejects account IDs that could change the signed bytes", () => {
    for (const accountId of ["", "a", "Alice.testnet", 'a","day":1,"x":"', "a..b", "-ab", "ab.", "a".repeat(65)]) {
      expect(() => checkInMessage(accountId, 1)).toThrow("Invalid account ID");
    }
  });

  test("rejects days outside u32", () => {
    for (const day of [-1, 1.5, 4294967296, Number.NaN]) {
      expect(() => checkInMessage("alice.testnet", day)).toThrow("Invalid day");
    }
  });
});

describe("serializeNep413Payload", () => {
  test("matches the NEP-413 specification example byte for byte", () => {
    // Example from the specification: message "hi", nonce [0..31], recipient "myapp.com",
    // callbackUrl "myapp.com/callback". Expected bytes written out by hand from the Borsh rules.
    const expected = [
      "9d010080", // u32 little-endian 2147484061
      "02000000", // message length
      "6869", // "hi"
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", // nonce
      "09000000", // recipient length
      "6d796170702e636f6d", // "myapp.com"
      "01", // callbackUrl is Some
      "12000000", // callbackUrl length
      "6d796170702e636f6d2f63616c6c6261636b", // "myapp.com/callback"
    ].join("");

    const serialized = serializeNep413Payload({
      message: "hi",
      nonce: Uint8Array.from({ length: 32 }, (_, index) => index),
      recipient: "myapp.com",
      callbackUrl: "myapp.com/callback",
    });

    expect(bytesToHex(serialized)).toBe(expected);
  });

  test("writes a single zero byte when there is no callback URL", () => {
    const serialized = serializeNep413Payload({ message: "hi", nonce: new Uint8Array(32), recipient: "r" });
    expect(bytesToHex(serialized.slice(-6))).toBe("010000007200");
  });

  test("counts string length in UTF-8 bytes", () => {
    const serialized = serializeNep413Payload({ message: "é", nonce: new Uint8Array(32), recipient: "r" });
    expect(bytesToHex(serialized.slice(4, 10))).toBe("02000000c3a9");
  });

  test("rejects a nonce that is not 32 bytes", () => {
    expect(() => serializeNep413Payload({ message: "hi", nonce: new Uint8Array(31), recipient: "r" })).toThrow(
      "The nonce must be 32 bytes"
    );
  });
});

describe("public keys", () => {
  test("format and parse the RFC 8032 test key the same way near-api-js does", async () => {
    const seed = hexToBytes(RFC8032_SEED_HEX);
    const signer = KeyPairSigner.fromSecretKey(`ed25519:${bytesToBase58(Uint8Array.from([...seed, ...publicKey]))}`);
    const formatted = formatEd25519PublicKey(publicKey);

    // near-api-js derives the public key from the secret key; RFC 8032 publishes the same value.
    expect((await signer.getPublicKey()).toString()).toBe(formatted);
    expect(formatted).toBe(vectorsFile.key.public_key);
    expect(parseEd25519PublicKey(formatted)).toEqual(publicKey);
  });

  test("rejects other curves, wrong lengths, and invalid base58", () => {
    expect(() => parseEd25519PublicKey("secp256k1:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z")).toThrow("ed25519:");
    expect(() => parseEd25519PublicKey("FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z")).toThrow("ed25519:");
    expect(() => parseEd25519PublicKey("ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS9")).toThrow("32 bytes");
    expect(() => parseEd25519PublicKey("ed25519:0OIl")).toThrow("Invalid base58");
    expect(() => formatEd25519PublicKey(new Uint8Array(31))).toThrow("32 bytes");
  });
});

describe("verifyNep413Signature", () => {
  test("accepts a check-in signed by the independent near-api-js signer", async () => {
    expect(await verify(validPayload)).toBe(true);
  });

  test("hashes exactly what the independent signer signed", async () => {
    // Ed25519 is deterministic: signing this module's hash with the raw key through WebCrypto gives
    // the near-api-js signature only if both hashed the same bytes.
    const pkcs8 = hexToBytes(`302e020100300506032b657004220420${RFC8032_SEED_HEX}`);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, await hashNep413Payload(validPayload));

    expect(bytesToHex(new Uint8Array(signature))).toBe(validVector.signature_hex);
    expect(bytesToHex(await hashNep413Payload(validPayload))).toBe(validVector.signed_hash_hex);
  });

  test("rejects a changed day, account, recipient, or nonce", async () => {
    const nonce = hexToBytes(validVector.nonce_hex);
    const base = { accountId: validVector.account_id, day: validVector.day, nonce, contractId: validVector.recipient };

    expect(await verify(checkInPayload({ ...base, day: base.day + 1 }))).toBe(false);
    expect(await verify(checkInPayload({ ...base, accountId: "bob.testnet" }))).toBe(false);
    expect(await verify(checkInPayload({ ...base, contractId: "other.testnet" }))).toBe(false);
    expect(await verify(checkInPayload({ ...base, nonce: createNonce() }))).toBe(false);
  });

  test("rejects a signature made over a payload with a callback URL when none is expected", async () => {
    const signature = base64ToBytes(callbackVector.signature_base64);
    if (callbackVector.signed_callback_url === null) throw new Error("The callback vector has no callback URL");

    // Same account, day, nonce, and recipient as the valid vector: only the callback URL differs.
    expect(await verify(validPayload, signature)).toBe(false);
    expect(await verify({ ...validPayload, callbackUrl: callbackVector.signed_callback_url }, signature)).toBe(true);
  });

  test("rejects a wrong key and malformed keys or signatures without throwing", async () => {
    const otherKey = hexToBytes("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
    const flipped = Uint8Array.from(validSignature);
    flipped[0] = (flipped[0] ?? 0) ^ 1;

    expect(await verify(validPayload, validSignature, otherKey)).toBe(false);
    expect(await verify(validPayload, flipped)).toBe(false);
    expect(await verify(validPayload, validSignature.slice(0, 63))).toBe(false);
    expect(await verify(validPayload, new Uint8Array(0))).toBe(false);
    expect(await verify(validPayload, validSignature, publicKey.slice(0, 31))).toBe(false);
    expect(await verify(validPayload, validSignature, new Uint8Array(32))).toBe(false);
  });
});

describe("vector file", () => {
  test("is exactly what the builder produces", async () => {
    expect(vectorsFile).toEqual(await buildVectors());
  });

  test("marks vectors valid or invalid as this module verifies them without a callback URL", async () => {
    for (const vector of vectorsFile.vectors) {
      const payload = checkInPayload({
        accountId: vector.account_id,
        day: vector.day,
        nonce: base64ToBytes(vector.nonce_base64),
        contractId: vector.recipient,
      });
      const accepted = await verify(payload, base64ToBytes(vector.signature_base64));
      expect(accepted ? "valid" : "invalid").toBe(vector.expected);
    }
  });
});

test("createNonce returns 32 fresh random bytes", () => {
  const first = createNonce();
  expect(first.length).toBe(32);
  expect(bytesToHex(first)).not.toBe(bytesToHex(createNonce()));
});
