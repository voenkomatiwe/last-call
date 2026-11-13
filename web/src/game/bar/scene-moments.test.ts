import { expect, test } from "bun:test";

import { shortName } from "./scene-moments";

test("short names drop the network and keep the part that tells accounts apart", () => {
  expect(shortName("kai.testnet", 12)).toBe("kai");
  expect(shortName("proverka.testnet", 12)).toBe("proverka");
  expect(shortName("lastcall-bot-gfeaq-1.testnet", 12)).toBe("…bot-gfeaq-1");
  expect(shortName("lastcall-bot-gfeaq-2.testnet", 12)).not.toBe(shortName("lastcall-bot-gfeaq-1.testnet", 12));
  expect(shortName("alice.near", 12)).toBe("alice");
  expect(shortName("sub.alice.near", 12)).toBe("sub.alice");
});
