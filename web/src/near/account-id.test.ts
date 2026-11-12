import { expect, test } from "bun:test";

import { isValidAccountId } from "./account-id";

test("accepts NEAR account IDs", () => {
  for (const id of ["ab", "alice.testnet", "a-b_c.near", "lastcall.test.near", "a".repeat(64)]) {
    expect(isValidAccountId(id)).toBe(true);
  }
});

test("rejects malformed account IDs", () => {
  for (const id of ["", "a", "Alice.near", "a..b", "-ab", "ab-", "ab.", ".ab", "a b", "a__b", "a".repeat(65)]) {
    expect(isValidAccountId(id)).toBe(false);
  }
});
