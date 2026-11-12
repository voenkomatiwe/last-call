import { hexToBytes } from "../near/encoding";
import { verifyNep413Signature } from "./nep413";
import vectorsFile from "./nep413-vectors.json";

/**
 * Verifies a known-good vector. `verifyNep413Signature` returns false both for a bad signature and
 * on a runtime without WebCrypto Ed25519; this tells the two apart.
 */
export async function canVerifyEd25519(): Promise<boolean> {
  const vector = vectorsFile.vectors[0];
  if (!vector) return false;
  return verifyNep413Signature({
    payload: { message: vector.message, nonce: hexToBytes(vector.nonce_hex), recipient: vector.recipient },
    signature: hexToBytes(vector.signature_hex),
    publicKey: hexToBytes(vectorsFile.key.public_key_hex),
  });
}
