import { formatEd25519PublicKey } from "./nep413";

// The browser check-in key (plan decision "12.11 (поздно ночью)"). The private key is a
// non-extractable WebCrypto Ed25519 key: page code can sign with it but never read it out. On chain it
// is a function-call access key of the member's own account, limited to the Last Call contract and
// `check_in`, so it cannot move funds. Kept per contract and account in IndexedDB.

export interface KeyStore {
  load(id: string): Promise<CryptoKeyPair | undefined>;
  save(id: string, pair: CryptoKeyPair): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The storage id of a member's key: one key per contract and account. */
export function keyId(contractId: string, accountId: string): string {
  return `${contractId}/${accountId}`;
}

/** True when this runtime can create and use Ed25519 keys with WebCrypto. */
export async function supportsBrowserKeys(): Promise<boolean> {
  try {
    const pair = await generateCheckinKey();
    await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(1));
    return true;
  } catch {
    return false;
  }
}

function isKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return "privateKey" in value && "publicKey" in value;
}

/** A new key pair; the private key is not extractable. */
export async function generateCheckinKey(): Promise<CryptoKeyPair> {
  const generated: CryptoKey | CryptoKeyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  if (!isKeyPair(generated)) throw new Error("Ed25519 key generation returned a single key");
  return generated;
}

/** `ed25519:<base58>` of the public key, as `join` and `set_checkin_key` take it. */
export async function publicKeyString(pair: CryptoKeyPair): Promise<string> {
  return formatEd25519PublicKey(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
}

/** For tests and runtimes without IndexedDB. */
export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, CryptoKeyPair>();
  async load(id: string) {
    return this.keys.get(id);
  }
  async save(id: string, pair: CryptoKeyPair) {
    this.keys.set(id, pair);
  }
  async remove(id: string) {
    this.keys.delete(id);
  }
}
