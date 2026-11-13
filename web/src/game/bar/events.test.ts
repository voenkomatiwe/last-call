import { describe, expect, test } from "bun:test";

import type { MemberView, OpenDayView, StateView } from "../../contract/views";
import { type BarSnapshot, barDay, barMode, drunkLevel, sceneEvents } from "./events";
import { bartenderError, ownCheckInLine } from "./lines";

const member: MemberView = {
  stake: 1n,
  joinDay: 1,
  activationDay: 3,
  lastCheckin: 9,
  resolvedThrough: 10,
  claimable: 0n,
  checkins: 5,
  personalStreak: 5,
  bestPersonalStreak: 5,
  heroCount: 0,
  storageDeposit: 1n,
  checkinKey: null,
  effectiveStake: 1n,
  pendingClaimable: 0n,
  isActive: true,
  checkedInToday: false,
  canCheckInToday: true,
  currentPersonalStreak: 5,
  kickableFromDay: 16,
};

const state = { today: 10 } as StateView;

const openDay: OpenDayView = {
  day: 10,
  goal: 6,
  count: 3,
  active: 10,
  forfeited: 0,
  closers: ["a.testnet", "b.testnet"],
  isIdle: false,
  stale: false,
};

function snap(overrides: Partial<OpenDayView>, checkedInToday = false, accountId = "me.testnet"): BarSnapshot {
  return { day: barDay(state, { ...openDay, ...overrides }), checkedInToday, accountId };
}

describe("barMode", () => {
  test("follows the member record from get_member", () => {
    expect(barMode(member, false)).toBe("ready");
    expect(barMode({ ...member, isActive: false, canCheckInToday: false }, false)).toBe("warmup");
    expect(barMode({ ...member, checkedInToday: true, canCheckInToday: false }, false)).toBe("done-today");
    expect(barMode(member, true)).toBe("backlog");
  });

  test("already checked in wins over backlog and warm-up", () => {
    expect(barMode({ ...member, checkedInToday: true }, true)).toBe("done-today");
  });
});

describe("barDay", () => {
  test("a stale open day means today has no check-ins and no goal yet", () => {
    expect(barDay({ today: 11 } as StateView, { ...openDay, stale: true })).toEqual({
      day: 11,
      count: 0,
      goal: null,
      isIdle: false,
      closers: [],
    });
  });

  test("an idle day has no goal", () => {
    expect(barDay(state, { ...openDay, isIdle: true }).goal).toBeNull();
  });
});

describe("sceneEvents", () => {
  test("the first poll replays nothing", () => {
    expect(sceneEvents(null, snap({ count: 5 }))).toEqual([]);
  });

  test("another account's check-in makes a patron drink", () => {
    expect(sceneEvents(snap({}), snap({ count: 4, closers: ["a.testnet", "b.testnet", "c.testnet"] }))).toEqual([
      { kind: "others-checked-in", count: 1, names: ["c.testnet"] },
    ]);
  });

  test("the player's own check-in is not another patron", () => {
    expect(sceneEvents(snap({}), snap({ count: 4, closers: [...openDay.closers, "me.testnet"] }, true))).toEqual([]);
  });

  test("own and another check-in in the same poll: one patron, without the player's name", () => {
    const next = snap({ count: 5, closers: [...openDay.closers, "me.testnet", "c.testnet"] }, true);
    expect(sceneEvents(snap({}), next)).toEqual([{ kind: "others-checked-in", count: 1, names: ["c.testnet"] }]);
  });

  test("names are only the newest closers, at most one per check-in", () => {
    const next = snap({ count: 6, closers: ["b.testnet", "c.testnet", "d.testnet", "e.testnet"] });
    const [first] = sceneEvents(snap({ count: 4 }), next);
    expect(first).toEqual({ kind: "others-checked-in", count: 2, names: ["d.testnet", "e.testnet"] });
  });

  test("reaching the goal rings the bell once", () => {
    expect(sceneEvents(snap({ count: 5 }), snap({ count: 6 }))).toEqual([
      { kind: "others-checked-in", count: 1, names: [] },
      { kind: "goal-reached", day: 10 },
    ]);
    expect(sceneEvents(snap({ count: 6 }), snap({ count: 7 }))).toEqual([
      { kind: "others-checked-in", count: 1, names: [] },
    ]);
  });

  test("the player's own check-in can reach the goal", () => {
    expect(sceneEvents(snap({ count: 5 }), snap({ count: 6 }, true))).toEqual([{ kind: "goal-reached", day: 10 }]);
  });

  test("no bell on an idle day or before the day opens", () => {
    expect(sceneEvents(snap({ count: 5, isIdle: true }), snap({ count: 6, isIdle: true }))).toEqual([
      { kind: "others-checked-in", count: 1, names: [] },
    ]);
  });

  test("a new day resets without replaying its check-ins", () => {
    expect(sceneEvents(snap({ count: 6 }), snap({ day: 11, count: 2 }))).toEqual([{ kind: "new-day", day: 11 }]);
  });

  test("a stale read after the day ended starts the new day", () => {
    const stale = { day: barDay({ today: 11 } as StateView, { ...openDay, stale: true }), checkedInToday: false };
    expect(sceneEvents(snap({ count: 6 }), { ...stale, accountId: null })).toEqual([{ kind: "new-day", day: 11 }]);
  });

  test("an older read (a lagging cache) is ignored", () => {
    expect(sceneEvents(snap({ day: 11, count: 1 }), snap({ day: 10, count: 6 }))).toEqual([]);
    expect(sceneEvents(snap({ count: 4 }), snap({ count: 3 }))).toEqual([]);
  });
});

describe("drunk UI", () => {
  test("starts at the threshold and saturates", () => {
    expect(drunkLevel(6)).toBe(0);
    expect(drunkLevel(7)).toBeCloseTo(0.35);
    expect(drunkLevel(17)).toBe(1);
    expect(drunkLevel(40)).toBe(1);
  });
});

describe("bartender lines", () => {
  const first = (lines: readonly string[]) => lines[0] as string;

  test("own check-in: number, closers, goal, late", () => {
    expect(ownCheckInLine({ n: 3, goal: 6, inClosers: false }, first)).toBe("Bottoms up! You're #3");
    expect(ownCheckInLine({ n: 5, goal: 6, inClosers: true }, first)).toBe("Bottoms up! #5, you're a closer");
    expect(ownCheckInLine({ n: 6, goal: 6, inClosers: true }, first)).toBe("You closed the goal. Ring it!");
    expect(ownCheckInLine({ n: 7, goal: 6, inClosers: false }, first)).toBe("Goal's done. Counted, no hero ticket");
    // a quiet night (contract returns goal 0): not "late", the streak still counts
    expect(ownCheckInLine({ n: 1, goal: 0, inClosers: false }, first)).toBe(
      "Quiet night, no goal. Your streak still counts"
    );
  });

  test("contract errors are explained", () => {
    expect(bartenderError(new Error("Smart contract panicked: ERR_ALREADY_CHECKED_IN"))).toContain(
      "already checked in"
    );
    expect(bartenderError(new Error("FunctionCallError ERR_BACKLOG"))).toContain("Settle");
    expect(bartenderError(new Error("ERR_LOW_GAS"))).toBe("Not counted: ERR_LOW_GAS");
  });

  test("the wallet's refusal is told apart", () => {
    expect(bartenderError(new Error("User rejected"))).toContain("Wallet didn't sign");
    expect(bartenderError("User cancelled the transaction")).toContain("Wallet didn't sign");
  });

  test("anything else is shown, shortened", () => {
    const text = bartenderError(new Error("x".repeat(200)));
    expect(text.length).toBeLessThan(110);
    expect(text.startsWith("Not counted: ")).toBe(true);
  });
});
