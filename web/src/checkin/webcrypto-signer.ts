import { PublicKey, Signer } from "near-api-js";

import { publicKeyString } from "./browser-key";

/**
 * A near-api-js signer over a non-extractable WebCrypto Ed25519 key. near-api-js hashes the
 * transaction (sha256 of its borsh encoding) and passes the hash to `signBytes`; the key signs it
 * without ever being exported.
 */
export class WebCryptoSigner extends Signer {
  constructor(private readonly pair: CryptoKeyPair) {
    super();
  }

  override async getPublicKey(): Promise<PublicKey> {
    return PublicKey.from(await publicKeyString(this.pair));
  }

  protected override async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign("Ed25519", this.pair.privateKey, Uint8Array.from(bytes)));
  }
}
