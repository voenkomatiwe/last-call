import { type Nep413Payload, parseEd25519PublicKey, verifyNep413Signature } from "../checkin/nep413";
import vectorsFile from "../checkin/nep413-vectors.json";
import { base58ToBytes, base64ToBytes, hexToBytes } from "../near/encoding";

// Tells whether a wallet's `signMessage` result is a signature the contract would accept.
// The contract rebuilds the NEP-413 payload without a callback URL (plan section 4.10), while the
// specification lets browser wallets add one, so the diagnosis also tries the likely URLs.

export type SignatureEncoding = "base64" | "base58";

export type SignatureDiagnosis =
  /** Verifies over the payload exactly as the contract rebuilds it. */
  | { readonly verdict: "matches-contract"; readonly signatureEncoding: SignatureEncoding }
  /** Verifies only when this callback URL is part of the payload: the contract would reject it. */
  | {
      readonly verdict: "signed-with-callback-url";
      readonly callbackUrl: string;
      readonly signatureEncoding: SignatureEncoding;
    }
  /** Well-formed, but verifies over none of the tried payloads. */
  | { readonly verdict: "no-match"; readonly signatureEncoding: SignatureEncoding }
  /** The public key or the signature cannot be decoded. */
  | { readonly verdict: "malformed"; readonly problem: string }
  /** This runtime cannot verify ed25519 signatures, so nothing can be concluded. */
  | { readonly verdict: "unsupported-runtime" };

export interface DiagnoseSignedMessageInput {
  /** The payload that was given to the wallet, without a callback URL. */
  readonly payload: Nep413Payload;
  /** `publicKey` as the wallet returned it. */
  readonly publicKey: string;
  /** `signature` as the wallet returned it. */
  readonly signature: string;
  /** Callback URLs the wallet may have added, such as the page URL and its origin. */
  readonly callbackUrlCandidates: readonly string[];
}

const ED25519_SIGNATURE_LENGTH = 64;

/** Verifies a known-good vector: false means the runtime lacks WebCrypto Ed25519. */
async function canVerifyEd25519(): Promise<boolean> {
  const vector = vectorsFile.vectors[0];
  if (!vector) return false;
  return verifyNep413Signature({
    payload: { message: vector.message, nonce: hexToBytes(vector.nonce_hex), recipient: vector.recipient },
    signature: hexToBytes(vector.signature_hex),
    publicKey: hexToBytes(vectorsFile.key.public_key_hex),
  });
}

/** NEP-413 says base64. Some wallets return base58, with or without the `ed25519:` prefix. */
function decodeSignature(signature: string): { bytes: Uint8Array; encoding: SignatureEncoding } | undefined {
  const decoders: ReadonlyArray<[SignatureEncoding, () => Uint8Array]> = [
    ["base64", () => base64ToBytes(signature)],
    ["base58", () => base58ToBytes(signature.replace(/^ed25519:/, ""))],
  ];
  for (const [encoding, decode] of decoders) {
    try {
      const bytes = decode();
      if (bytes.length === ED25519_SIGNATURE_LENGTH) return { bytes, encoding };
    } catch {
      // Not this encoding.
    }
  }
  return undefined;
}

export async function diagnoseSignedMessage(input: DiagnoseSignedMessageInput): Promise<SignatureDiagnosis> {
  if (!(await canVerifyEd25519())) return { verdict: "unsupported-runtime" };

  let publicKey: Uint8Array;
  try {
    publicKey = parseEd25519PublicKey(input.publicKey);
  } catch (error) {
    return { verdict: "malformed", problem: error instanceof Error ? error.message : "Invalid public key" };
  }

  const signature = decodeSignature(input.signature);
  if (!signature) {
    return { verdict: "malformed", problem: "The signature is not 64 bytes in base64 or base58" };
  }

  const { callbackUrl: _ignored, ...withoutCallback } = input.payload;
  if (await verifyNep413Signature({ payload: withoutCallback, signature: signature.bytes, publicKey })) {
    return { verdict: "matches-contract", signatureEncoding: signature.encoding };
  }

  for (const callbackUrl of input.callbackUrlCandidates) {
    const payload = { ...withoutCallback, callbackUrl };
    if (await verifyNep413Signature({ payload, signature: signature.bytes, publicKey })) {
      return { verdict: "signed-with-callback-url", callbackUrl, signatureEncoding: signature.encoding };
    }
  }

  return { verdict: "no-match", signatureEncoding: signature.encoding };
}
