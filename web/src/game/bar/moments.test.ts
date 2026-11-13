import { describe, expect, test } from "bun:test";

import type { DaySummary } from "../../contract/views";
import { deadLetters, failedDays, historyEvents, initialPot, jarLevel, SIGN, seatClosers } from "./events";
import { claimError, heroLine, settledLine } from "./lines";

const first = (lines: readonly string[]) => lines[0] ?? "";

function summary(day: number, outcome: DaySummary["outcome"], hero: string | null = null): DaySummary {
  return {
    day,
    outcome,
    goal: 6,
    count: outcome === "Success" ? 7 : 3,
    streakAfter: 0,
    perShare: 0n,
    jackpot: hero || outcome === "Success" ? 500n : 0n,
    hero,
    potBurned: outcome === "Fail" ? 10n : 0n,
    stakeSlashed: 0n,
    potAfter: 1_000n,
  };
}

describe("historyEvents", () => {
  test("the first poll replays nothing", () => {
    expect(historyEvents(null, [summary(9, "Fail"), summary(8, "Success", "a.near")])).toEqual([]);
  });

  test("an unchanged history gives nothing", () => {
    const h = [summary(9, "Fail"), summary(8, "Success", "a.near")];
    expect(historyEvents(h, [...h])).toEqual([]);
  });

  test("a newly settled successful day is one moment; its hero comes later", () => {
    const prev = [summary(8, "Success", "a.near")];
    const settled = summary(9, "Success");
    const afterSettle = [settled, ...prev];
    expect(historyEvents(prev, afterSettle)).toEqual([{ kind: "day-settled", summary: settled }]);
    const drawn = summary(9, "Success", "b.near");
    expect(historyEvents(afterSettle, [drawn, ...prev])).toEqual([
      { kind: "hero-picked", day: 9, hero: "b.near", jackpot: 500n },
    ]);
  });

  test("settle and draw between two polls give both moments, settle first", () => {
    const prev = [summary(8, "Fail")];
    const day = summary(9, "Success", "c.near");
    expect(historyEvents(prev, [day, ...prev])).toEqual([
      { kind: "day-settled", summary: day },
      { kind: "hero-picked", day: 9, hero: "c.near", jackpot: 500n },
    ]);
  });

  test("a failed day settles; several days settle oldest first; idle days stay quiet", () => {
    const prev = [summary(7, "Success", "a.near")];
    const next = [summary(10, "Fail"), summary(9, "Idle"), summary(8, "Fail"), ...prev];
    expect(historyEvents(prev, next).map((e) => (e.kind === "day-settled" ? e.summary.day : -1))).toEqual([8, 10]);
  });

  test("a day that falls out of the capped history is not a moment, nor is an older day appearing", () => {
    const prev = [summary(10, "Success", "a.near"), summary(9, "Fail")];
    expect(historyEvents(prev, [summary(10, "Success", "a.near")])).toEqual([]);
    expect(historyEvents(prev, [...prev, summary(3, "Fail")])).toEqual([]);
  });

  test("from an empty history the first settled day still counts", () => {
    const day = summary(1, "Fail");
    expect(historyEvents([], [day])).toEqual([{ kind: "day-settled", summary: day }]);
  });
});

describe("the neon sign", () => {
  test("each failed day in the history kills one more letter, never a space, and they stay dead", () => {
    const history = [summary(5, "Fail"), summary(4, "Success"), summary(3, "Fail"), summary(2, "Idle")];
    expect(failedDays(history)).toBe(2);
    const two = deadLetters(2);
    expect(two.size).toBe(2);
    const three = deadLetters(3);
    for (const i of two) expect(three.has(i)).toBe(true);
    for (const i of deadLetters(99)) expect(SIGN[i]).not.toBe(" ");
    expect(deadLetters(99).size).toBe(SIGN.replaceAll(" ", "").length);
    expect(deadLetters(0).size).toBe(0);
  });
});

describe("the coin jar", () => {
  test("level is the pot against its launch size", () => {
    const initial = initialPot(10n ** 27n, 5000);
    expect(initial).toBe(5n * 10n ** 26n);
    expect(jarLevel(initial, initial)).toBe(1);
    expect(jarLevel(initial / 2n, initial)).toBe(0.5);
    expect(jarLevel(0n, initial)).toBe(0);
    expect(jarLevel(1n, initial)).toBe(0.04);
    expect(jarLevel(initial * 2n, initial)).toBe(1);
    expect(jarLevel(5n, 0n)).toBe(1);
  });
});

describe("closers", () => {
  test("the player is seated apart; the rest keep their order", () => {
    expect(seatClosers(["a", "me", "b"], "me")).toEqual({ others: ["a", "b"], self: true });
    expect(seatClosers(["a", "b"], "me")).toEqual({ others: ["a", "b"], self: false });
    expect(seatClosers(["a"], null)).toEqual({ others: ["a"], self: false });
  });
});

describe("moment lines", () => {
  test("settled and hero lines carry the day, the hero and the jackpot", () => {
    expect(settledLine(12, "Success", first)).toContain("12");
    expect(settledLine(12, "Fail", first)).toContain("letter");
    expect(heroLine(12, "kai.near", false, "2.4K", first)).toBe("Hero of night 12: kai.near. Jackpot 2.4K");
    expect(heroLine(12, "me.near", true, "2.4K", first)).toContain("YOU");
  });

  test("claim errors are explained", () => {
    expect(claimError(new Error("Smart contract panicked: ERR_NOTHING_TO_CLAIM"))).toContain("empty");
    expect(claimError(new Error("Smart contract panicked: ERR_BACKLOG"))).toContain("Settle");
    expect(claimError(new Error("User rejected the request"))).toContain("didn't sign");
    expect(claimError("boom")).toBe("Till's stuck: boom");
  });
});
