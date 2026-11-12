import { expect, test } from "bun:test";

import { generateCheckinKey, keyId, MemoryKeyStore, publicKeyString, supportsBrowserKeys } from "./browser-key";
import { parseEd25519PublicKey } from "./nep413";

test("this runtime supports Ed25519 keys", async () => {
  expect(await supportsBrowserKeys()).toBe(true);
});

test("the private key cannot be exported; the public key formats as ed25519:<base58>", async () => {
  const pair = await generateCheckinKey();
  expect(pair.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
  const key = await publicKeyString(pair);
  expect(key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  expect(parseEd25519PublicKey(key)).toHaveLength(32);
});

test("keys are stored per contract and account and survive a structured clone", async () => {
  const store = new MemoryKeyStore();
  const pair = await generateCheckinKey();
  const id = keyId("lastcall.testnet", "alice.testnet");
  expect(id).not.toBe(keyId("lastcall.testnet", "bob.testnet"));
  await store.save(id, structuredClone(pair));
  const loaded = await store.load(id);
  expect(loaded && (await publicKeyString(loaded))).toBe(await publicKeyString(pair));
  await store.remove(id);
  expect(await store.load(id)).toBeUndefined();
});
