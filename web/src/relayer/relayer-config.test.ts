import { expect, test } from "bun:test";

import { relayerFromEnv } from "./relayer-config";

const PUBLIC = { NEXT_PUBLIC_CONTRACT_ID: "lastcall.testnet" };
// near-sandbox's publicly known default key (`DEFAULT_PRIVATE_KEY`): valid syntax, no real funds.
const SECRET = "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB";

test("without relayer variables the relayer is off (the route answers 503)", () => {
  expect(relayerFromEnv(PUBLIC)).toBeNull();
});

test("a configured relayer is built", () => {
  expect(
    relayerFromEnv({ ...PUBLIC, RELAYER_ACCOUNT_ID: "relayer.testnet", RELAYER_PRIVATE_KEY: SECRET })
  ).not.toBeNull();
});

test("half a configuration or a bad value fails without echoing the key", () => {
  const messages: string[] = [];
  for (const env of [
    { ...PUBLIC, RELAYER_ACCOUNT_ID: "relayer.testnet" },
    { ...PUBLIC, RELAYER_PRIVATE_KEY: SECRET },
    { ...PUBLIC, RELAYER_ACCOUNT_ID: "Bad Id", RELAYER_PRIVATE_KEY: SECRET },
    { ...PUBLIC, RELAYER_ACCOUNT_ID: "relayer.testnet", RELAYER_PRIVATE_KEY: "secp256k1:abc" },
  ]) {
    try {
      relayerFromEnv(env);
      messages.push("no error");
    } catch (error) {
      messages.push((error as Error).message);
    }
  }
  expect(messages).not.toContain("no error");
  for (const message of messages) expect(message).not.toContain(SECRET.slice(8, 30));
});
