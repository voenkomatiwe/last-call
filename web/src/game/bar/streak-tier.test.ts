import { describe, expect, test } from "bun:test";

import {
  formatMultiplier,
  nightsToNextTier,
  primaryAction,
  streakAtRisk,
  streakMultiplierBps,
  streakTier,
} from "./streak-tier";

describe("streak tiers", () => {
  test("boundaries", () => {
    const ids = [0, 1, 2, 3, 6, 7, 13, 14, 29, 30, 365].map((s) => streakTier(s).id);
    expect(ids).toEqual([
      "novice",
      "guest",
      "guest",
      "regular",
      "regular",
      "local",
      "local",
      "legend",
      "legend",
      "owner",
      "owner",
    ]);
  });

  test("indices rise by one and the top has no next tier", () => {
    expect([0, 1, 3, 7, 14, 30].map((s) => streakTier(s).index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(streakTier(30).next).toBeNull();
    expect(streakTier(7).next).toBe(14);
  });

  test("bad input falls back to the tier below", () => {
    expect(streakTier(-3).id).toBe("novice");
    expect(streakTier(2.9).id).toBe("guest");
  });

  test("nights to the next tier", () => {
    expect(nightsToNextTier(0)).toBe(1);
    expect(nightsToNextTier(4)).toBe(3);
    expect(nightsToNextTier(29)).toBe(1);
    expect(nightsToNextTier(30)).toBeNull();
  });
});

describe("streak multiplier (contract/API.md: 1 + min(streak, cap) × step / 10 000)", () => {
  test("mainnet and testnet set: step 1000, cap 30", () => {
    expect(streakMultiplierBps(0, 1000, 30)).toBe(10_000);
    expect(streakMultiplierBps(1, 1000, 30)).toBe(11_000);
    expect(streakMultiplierBps(13, 1000, 30)).toBe(23_000);
    expect(streakMultiplierBps(30, 1000, 30)).toBe(40_000);
    expect(streakMultiplierBps(58, 1000, 30)).toBe(40_000);
  });

  test("demo set caps at 10", () => {
    expect(streakMultiplierBps(12, 1000, 10)).toBe(20_000);
  });

  test("format", () => {
    expect(formatMultiplier(10_000)).toBe("×1.0");
    expect(formatMultiplier(23_000)).toBe("×2.3");
    expect(formatMultiplier(12_500)).toBe("×1.25");
  });
});

describe("streak at risk", () => {
  const night = 600_000;
  test("only with a streak, before the check-in, in the last 15%", () => {
    expect(streakAtRisk({ streak: 4, checkedInToday: false, msLeft: 80_000, dayLengthMs: night })).toBe(true);
    expect(streakAtRisk({ streak: 4, checkedInToday: false, msLeft: 100_000, dayLengthMs: night })).toBe(false);
    expect(streakAtRisk({ streak: 4, checkedInToday: true, msLeft: 10_000, dayLengthMs: night })).toBe(false);
    expect(streakAtRisk({ streak: 0, checkedInToday: false, msLeft: 10_000, dayLengthMs: night })).toBe(false);
  });
});

describe("primary action", () => {
  test("one thing at a time", () => {
    expect(primaryAction({ mode: "backlog", claimable: 5n })).toBe("settle");
    expect(primaryAction({ mode: "ready", claimable: 5n })).toBe("drink");
    expect(primaryAction({ mode: "done-today", claimable: 5n })).toBe("claim");
    expect(primaryAction({ mode: "done-today", claimable: 0n })).toBe("none");
    expect(primaryAction({ mode: "warmup", claimable: 0n })).toBe("none");
  });
});
