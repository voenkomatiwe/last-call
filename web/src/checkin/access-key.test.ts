import { expect, test } from "bun:test";

import {
  addCheckinKeyAction,
  enableCheckinKeyActions,
  isAllowanceExhausted,
  KEY_ALLOWANCE,
  KEY_CHECK_IN_GAS,
  keyCheckInCall,
  keyStatusFromView,
} from "./access-key";

const CONTRACT = "lastcall.testnet";
const fc = (receiver_id: string, method_names: string[]) => ({
  nonce: 1,
  permission: { FunctionCall: { receiver_id, method_names, allowance: "1" } },
});

test("only a check_in-only key for this contract counts as ready", () => {
  expect(keyStatusFromView(fc(CONTRACT, ["check_in"]), CONTRACT)).toBe("ready");
  expect(keyStatusFromView(fc("other.testnet", ["check_in"]), CONTRACT)).toBe("wrong-permission");
  expect(keyStatusFromView(fc(CONTRACT, []), CONTRACT)).toBe("wrong-permission"); // [] means any method
  expect(keyStatusFromView(fc(CONTRACT, ["check_in", "claim"]), CONTRACT)).toBe("wrong-permission");
  expect(keyStatusFromView({ nonce: 1, permission: "FullAccess" }, CONTRACT)).toBe("wrong-permission");
  expect(keyStatusFromView(null, CONTRACT)).toBe("wrong-permission");
});

test("the AddKey action limits the key to this contract and check_in, with a 1 NEAR allowance", () => {
  expect(addCheckinKeyAction(CONTRACT, "ed25519:abc")).toEqual({
    type: "AddKey",
    params: {
      publicKey: "ed25519:abc",
      accessKey: {
        permission: { receiverId: CONTRACT, allowance: KEY_ALLOWANCE.toString(), methodNames: ["check_in"] },
      },
    },
  });
});

test("the key's check-in carries no deposit and 50 Tgas", () => {
  expect(keyCheckInCall()).toEqual({
    methodName: "check_in",
    args: {},
    gas: KEY_CHECK_IN_GAS.toString(),
    deposit: "0",
  });
  expect(KEY_CHECK_IN_GAS).toBe(50n * 10n ** 12n);
});

test("an exhausted allowance is recognised by message, not only by the (minifiable) class name", () => {
  // The message near-api-js 7.4.0 builds (rpc-errors/index.js), with a renamed class as in a build.
  class i4 extends Error {}
  const message = "Not enough allowance for access key ed25519:abc on account alice.testnet (allowance: 1, cost: 2)";
  expect(isAllowanceExhausted(new i4(message))).toBe(true);
  expect(isAllowanceExhausted(new Error("Smart contract panicked: ERR_ALREADY_CHECKED_IN"))).toBe(false);
});

test("re-enabling replaces the previous check-in key in the same transaction", () => {
  expect(enableCheckinKeyActions(CONTRACT, "ed25519:new").map((action) => action.type)).toEqual(["AddKey"]);
  expect(enableCheckinKeyActions(CONTRACT, "ed25519:new", "ed25519:old")).toEqual([
    { type: "DeleteKey", params: { publicKey: "ed25519:old" } },
    addCheckinKeyAction(CONTRACT, "ed25519:new"),
  ]);
  expect(enableCheckinKeyActions(CONTRACT, "ed25519:same", "ed25519:same")).toHaveLength(1);
});
