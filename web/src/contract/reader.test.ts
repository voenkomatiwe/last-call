import { expect, test } from "bun:test";
import type { JsonRpcProvider } from "near-api-js";

import { ContractShapeError } from "./decode";
import { ContractReader } from "./reader";

/** A provider whose `callFunction` answers `get_kickable` pages from a function. */
function kickableProvider(page: (from: number) => unknown) {
  const calls: number[] = [];
  const provider = {
    callFunction: async ({ args }: { args: { from_index: number } }) => {
      calls.push(args.from_index);
      return page(args.from_index);
    },
  } as unknown as JsonRpcProvider;
  return { reader: new ContractReader(provider, "lastcall.testnet"), calls };
}

test("allKickable pages until next_index is null, including empty pages", async () => {
  const { reader, calls } = kickableProvider((from) =>
    from === 0
      ? { accounts: ["a.testnet"], next_index: 2 }
      : from === 2
        ? { accounts: [], next_index: 4 }
        : { accounts: ["b.testnet"], next_index: null }
  );
  expect(await reader.allKickable(2)).toEqual(["a.testnet", "b.testnet"]);
  expect(calls).toEqual([0, 2, 4]);
});

test("allKickable refuses a next_index that does not advance instead of looping", async () => {
  const { reader, calls } = kickableProvider((from) => ({ accounts: [], next_index: from }));
  await expect(reader.allKickable()).rejects.toThrow(ContractShapeError);
  expect(calls.length).toBe(1);
});
