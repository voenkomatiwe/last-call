import { describe, expect, test } from "bun:test";

import { formatLast, report, scenarioCsv } from "./run";
import { potHalfLifeDays, runScenario, SCENARIOS } from "./scenarios";

// Short runs (20 days) of every scenario. The harness checks the invariants after every call, so a
// run that finishes has kept them throughout.

const spec = (name: string) => {
  const found = SCENARIOS.find((scenario) => scenario.name === name);
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
};

describe("scenarios", () => {
  test.each(SCENARIOS.map((scenario) => [scenario.name]))("%s runs without unexpected refusals", (name) => {
    const result = runScenario(spec(name), { days: 20 });
    expect(result.unexpectedRefusals).toEqual([]);
    expect(result.days).toHaveLength(20);
    expect(result.days.map((row) => row.day)).toEqual(Array.from({ length: 20 }, (_, day) => day));
  });

  test("the same seed gives identical output; another seed does not", () => {
    const first = scenarioCsv(runScenario(spec("base"), { days: 20, seed: 7 }));
    expect(scenarioCsv(runScenario(spec("base"), { days: 20, seed: 7 }))).toBe(first);
    expect(scenarioCsv(runScenario(spec("base"), { days: 20, seed: 8 }))).not.toBe(first);
  });

  test("closers reward timing: block snipers take every closer seat, a one-block batch only one (R5)", () => {
    const blocks = runScenario(spec("sniper-blocks"), { days: 20 }).sniper;
    const batch = runScenario(spec("sniper-batch"), { days: 20 }).sniper;
    if (!blocks || !batch) throw new Error("no sniper stats");
    // Five snipers in five blocks fill the whole window of K = 5 on every successful day...
    expect(blocks.sniperCloserSeats).toBe(blocks.totalCloserSeats);
    expect(blocks.sniperJackpots).toBe(blocks.successDays);
    // ...while an atomic batch is one block: one candidate per successful day.
    expect(batch.sniperCloserSeats).toBe(batch.successDays);
    expect(batch.sniperJackpots).toBeLessThan(batch.successDays);
  });

  test("griefers get kicked and come back", () => {
    const result = runScenario(spec("griefer"), { days: 20 });
    const griefers = result.profiles.find((row) => row.profile === "griefer");
    expect(griefers?.kicked ?? 0).toBeGreaterThan(70);
    expect(griefers?.kickFees ?? 0n).toBeGreaterThan(0n);
  });

  test("the CSV has the plan's columns", () => {
    const csv = scenarioCsv(runScenario(spec("base"), { days: 5 }));
    expect(csv.split("\n")[0]).toBe("day,outcome,goal,count,streak,pot,total_supply,burned,per_share,hero_profile");
    expect(csv.trimEnd().split("\n")).toHaveLength(6);
  });

  test("the report names every scenario and the pot runway", () => {
    const results = ["base", "sniper-batch"].map((name) => runScenario(spec(name), { days: 5 }));
    const text = report(results, 42);
    expect(text).toContain("## base");
    expect(text).toContain("## sniper-batch");
    expect(text).toContain("## How long the pot lasts");
  });
});

describe("helpers", () => {
  test("formatLast rounds yocto-LAST to two decimals with grouped thousands", () => {
    expect(formatLast(0n)).toBe("0.00");
    expect(formatLast(1_234_567n * 10n ** 18n + 5n * 10n ** 15n)).toBe("1 234 567.01");
    expect(formatLast(-25n * 10n ** 17n)).toBe("−2.50");
  });

  test("the pot half-life matches the plan: about 1386 days at streak 0 and 346 at the cap", () => {
    expect(Math.round(potHalfLifeDays(5, 0, 30, 1000))).toBe(1386);
    expect(Math.round(potHalfLifeDays(5, 30, 30, 1000))).toBe(346);
  });
});
