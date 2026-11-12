import { expect, test } from "bun:test";

import type { DaySummary } from "../web/src/contract/views";
import { formatDay, formatTable, shortName } from "./demo-report";

const LAST = 10n ** 18n;
const base: DaySummary = {
  day: 1,
  outcome: "Success",
  goal: 6,
  count: 9,
  streakAfter: 1,
  perShare: 289n * LAST,
  jackpot: 2_890n * LAST,
  hero: "bot-5.sandbox",
  potBurned: 0n,
  stakeSlashed: 0n,
  potAfter: 0n,
};

test("a success names the closers, the hero, and the jackpot", () => {
  expect(formatDay(base, ["bot-2.sandbox", "you.sandbox"])).toBe(
    "Day 1: 9 of 6 checked in — SUCCESS, streak 1. Each +289.00 LAST; closers bot-2, you; hero bot-5 +2,890.00 LAST."
  );
  expect(formatDay({ ...base, hero: null, jackpot: 0n }, [])).toContain("no closers; no jackpot");
});

test("a failure shows both burns; an idle day says nothing changes", () => {
  const fail = { ...base, outcome: "Fail" as const, count: 3, potBurned: 25n * LAST, stakeSlashed: 6n * LAST };
  expect(formatDay(fail, [])).toBe(
    "Day 1: 3 of 6 checked in — FAIL, streak reset. Burnt 25.00 LAST from the pot and 6.00 LAST from absent stakes."
  );
  expect(formatDay({ ...base, outcome: "Idle", goal: 0 }, [])).toContain("idle");
});

test("names and the table", () => {
  expect(shortName("bot-3.sandbox")).toBe("bot-3");
  const table = formatTable([
    { name: "you", balance: LAST, stake: 2n * LAST, claimable: 0n, checkins: 5, heroCount: 1 },
  ]);
  expect(table.split("\n")).toHaveLength(2);
  expect(table).toContain("1.00 LAST");
  expect(table.split("\n")[0]).toStartWith("player");
});
