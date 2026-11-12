import { expect, test } from "bun:test";

import { summarizeAccessKeys } from "./access-keys";

test("counts keys and full-access keys", () => {
  expect(summarizeAccessKeys({ keys: [] })).toEqual({ total: 0, fullAccess: 0 });
  expect(
    summarizeAccessKeys({
      keys: [
        { public_key: "ed25519:a", access_key: { nonce: 1, permission: "FullAccess" } },
        {
          public_key: "ed25519:b",
          access_key: { nonce: 1, permission: { FunctionCall: { receiver_id: "x", method_names: [] } } },
        },
      ],
    })
  ).toEqual({ total: 2, fullAccess: 1 });
});

test("rejects a malformed answer", () => {
  expect(() => summarizeAccessKeys(null)).toThrow();
  expect(() => summarizeAccessKeys({ keys: {} })).toThrow();
  expect(() => summarizeAccessKeys({ keys: [{}] })).toThrow();
});
