import { expect, test } from "bun:test";

import { contractErrorCode } from "../contract/errors";
import { TransactionFailedError, transactionResult } from "./outcome";

const b64 = (text: string) => Buffer.from(text).toString("base64");

test("the method's JSON result is decoded from SuccessValue", () => {
  const value = '{"day":3,"n":4,"goal":5,"in_closers":true}';
  expect(transactionResult({ status: { SuccessValue: b64(value) } })).toEqual(JSON.parse(value));
  expect(transactionResult({ status: { SuccessValue: b64('"125"') } })).toBe("125");
  expect(transactionResult({ status: { SuccessValue: "" } })).toBeUndefined();
});

test("a contract panic surfaces its ERR_ code", () => {
  const failure = {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_ALREADY_CHECKED_IN" } },
    },
  };
  let caught: unknown;
  try {
    transactionResult({ status: { Failure: failure } });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TransactionFailedError);
  expect(contractErrorCode((caught as Error).message)).toBe("ERR_ALREADY_CHECKED_IN");
});

test("malformed outcomes are rejected", () => {
  expect(() => transactionResult(undefined)).toThrow(TransactionFailedError);
  expect(() => transactionResult({ status: "Started" })).toThrow(TransactionFailedError);
  expect(() => transactionResult({ status: {} })).toThrow(TransactionFailedError);
  expect(() => transactionResult({ status: { SuccessValue: 5 } })).toThrow(TransactionFailedError);
  expect(() => transactionResult({ status: { SuccessValue: b64("not json") } })).toThrow(TransactionFailedError);
});
