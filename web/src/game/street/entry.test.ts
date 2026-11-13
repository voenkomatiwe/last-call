import { describe, expect, test } from "bun:test";

import type { AccountSnapshot, GameSnapshot } from "../actions";
import { harnessData } from "../bar/harness-data";
import { entryStep } from "./entry";

const LAST = 10n ** 18n;
const base = harnessData({ day: 12, count: 3, goal: 6, isIdle: false, closers: [] }, false, 3, 0).game;

function game(over: { faucetAmount?: bigint; faucetLeft?: bigint; pendingDays?: number } = {}): GameSnapshot {
  return {
    ...base,
    config: { ...base.config, faucetAmount: over.faucetAmount ?? 0n },
    state: { ...base.state, faucetLeft: over.faucetLeft ?? 0n, pendingDays: over.pendingDays ?? 0 },
  };
}

const member = harnessData({ day: 12, count: 3, goal: 6, isIdle: false, closers: [] }, false, 3, 0).account
  ?.member as NonNullable<AccountSnapshot["member"]>;

function account(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return { accountId: "you.test", storage: { total: 1n, available: 0n }, balance: 0n, member: null, ...over };
}

describe("entry step", () => {
  test("no wallet: connect", () => {
    expect(entryStep(game(), null)).toEqual({ kind: "connect" });
  });

  test("a member goes straight to the bar, whatever else is true", () => {
    expect(entryStep(game({ pendingDays: 999 }), account({ storage: null, member })).kind).toBe("member");
  });

  test("no token account: register with the minimum storage deposit", () => {
    expect(entryStep(game(), account({ storage: null }))).toEqual({ kind: "register", deposit: base.bounds.min });
  });

  test("short of the stake with a faucet that still has tokens: faucet", () => {
    const step = entryStep(game({ faucetAmount: 5_000n * LAST, faucetLeft: 9_000n * LAST }), account());
    expect(step.kind).toBe("faucet");
  });

  test("short of the stake, faucet off or empty: no funds", () => {
    expect(entryStep(game(), account({ balance: 10n })).kind).toBe("no-funds");
    expect(entryStep(game({ faucetAmount: 5_000n * LAST, faucetLeft: 4_999n * LAST }), account()).kind).toBe(
      "no-funds"
    );
  });

  test("enough LAST but a backlog: settle first", () => {
    const step = entryStep(game({ pendingDays: 51 }), account({ balance: base.config.joinStake }));
    expect(step).toEqual({ kind: "settle", days: 51 });
  });

  test("a backlog within the auto-settle cap does not block join", () => {
    expect(entryStep(game({ pendingDays: 50 }), account({ balance: base.config.joinStake })).kind).toBe("join");
  });

  test("enough LAST: join with the stake and the member deposit", () => {
    expect(entryStep(game(), account({ balance: base.config.joinStake }))).toEqual({
      kind: "join",
      stake: base.config.joinStake,
      deposit: base.config.memberStorageDeposit,
      balance: base.config.joinStake,
    });
  });
});
