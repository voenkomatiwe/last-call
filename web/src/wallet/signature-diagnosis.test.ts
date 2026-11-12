import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { checkInPayload } from "../checkin/nep413";
import vectorsFile from "../checkin/nep413-vectors.json";
import { base64ToBytes, bytesToBase58, hexToBytes } from "../near/encoding";
import { diagnoseSignedMessage } from "./signature-diagnosis";

// The vectors were signed by near-api-js (see `nep413-vectors.build.ts`): the first without a
// callback URL, the third with one, over otherwise identical input.
const [plainVector, , callbackVector] = vectorsFile.vectors;
if (!plainVector || !callbackVector?.signed_callback_url) throw new Error("The vector file is missing vectors");

const signedCallbackUrl = callbackVector.signed_callback_url;
const publicKey = vectorsFile.key.public_key;
const payload = checkInPayload({
  accountId: plainVector.account_id,
  day: plainVector.day,
  nonce: hexToBytes(plainVector.nonce_hex),
  contractId: plainVector.recipient,
});
const candidates = ["https://other.example/", signedCallbackUrl];

function diagnose(
  overrides: { signature?: string; publicKey?: string; callbackUrlCandidates?: readonly string[] } = {}
) {
  return diagnoseSignedMessage({
    payload,
    publicKey,
    signature: plainVector?.signature_base64 ?? "",
    callbackUrlCandidates: candidates,
    ...overrides,
  });
}

describe("diagnoseSignedMessage", () => {
  test("a signature over the payload without a callback URL matches the contract", async () => {
    expect(await diagnose()).toEqual({ verdict: "matches-contract", signatureEncoding: "base64" });
  });

  test("a signature made with a callback URL is reported with that URL", async () => {
    expect(await diagnose({ signature: callbackVector.signature_base64 })).toEqual({
      verdict: "signed-with-callback-url",
      callbackUrl: signedCallbackUrl,
      signatureEncoding: "base64",
    });
  });

  test("a callback URL in the given payload is ignored: the contract never has one", async () => {
    const withCallback = { ...payload, callbackUrl: signedCallbackUrl };
    const diagnosis = await diagnoseSignedMessage({
      payload: withCallback,
      publicKey,
      signature: callbackVector.signature_base64,
      callbackUrlCandidates: [],
    });
    expect(diagnosis).toEqual({ verdict: "no-match", signatureEncoding: "base64" });
  });

  test("a signature that matches none of the tried payloads", async () => {
    expect(
      await diagnose({ signature: callbackVector.signature_base64, callbackUrlCandidates: ["https://other.example/"] })
    ).toEqual({
      verdict: "no-match",
      signatureEncoding: "base64",
    });
  });

  test("a base58 signature is accepted and its encoding is reported", async () => {
    const base58 = bytesToBase58(base64ToBytes(plainVector.signature_base64));
    expect(await diagnose({ signature: base58 })).toEqual({ verdict: "matches-contract", signatureEncoding: "base58" });
    expect(await diagnose({ signature: `ed25519:${base58}` })).toEqual({
      verdict: "matches-contract",
      signatureEncoding: "base58",
    });
  });

  test("malformed keys and signatures", async () => {
    expect(await diagnose({ publicKey: "secp256k1:abc" })).toMatchObject({ verdict: "malformed" });
    expect(await diagnose({ publicKey: plainVector.account_id })).toMatchObject({ verdict: "malformed" });
    expect(await diagnose({ signature: "" })).toMatchObject({ verdict: "malformed" });
    expect(await diagnose({ signature: "AAAA" })).toMatchObject({ verdict: "malformed" });
    expect(await diagnose({ signature: "not a signature!" })).toMatchObject({ verdict: "malformed" });
  });
});

describe("diagnoseSignedMessage without Ed25519 support", () => {
  afterEach(() => {
    spyOn(crypto.subtle, "importKey").mockRestore();
  });

  test("reports the runtime instead of calling a good signature bad", async () => {
    spyOn(crypto.subtle, "importKey").mockRejectedValue(new DOMException("Unrecognized name.", "NotSupportedError"));
    expect(await diagnose()).toEqual({ verdict: "unsupported-runtime" });
  });
});
