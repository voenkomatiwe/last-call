import type { KeyStore } from "./browser-key";

// Browser-only storage of check-in keys. IndexedDB keeps `CryptoKey` objects by structured clone,
// so the private key stays non-extractable. Imported only by client components.

const DB_NAME = "last-call";
const STORE = "checkin-keys";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB stores `CryptoKey` objects by structured clone; the private key stays non-extractable. */
export class IndexedDbKeyStore implements KeyStore {
  private db: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async load(id: string): Promise<CryptoKeyPair | undefined> {
    const value = (await request((await this.store("readonly")).get(id))) as CryptoKeyPair | undefined;
    return value?.privateKey && value.publicKey ? value : undefined;
  }

  async save(id: string, pair: CryptoKeyPair): Promise<void> {
    await request((await this.store("readwrite")).put(pair, id));
  }

  async remove(id: string): Promise<void> {
    await request((await this.store("readwrite")).delete(id));
  }
}
