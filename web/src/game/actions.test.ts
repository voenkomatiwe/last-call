import { describe, expect, test } from "bun:test";

import type { ConfigView, MemberView, StateView } from "../contract/views";
import { type AccountSnapshot, accountActions, exitFee, type GameSnapshot } from "./actions";

const LAST = 10n ** 18n;

const config: ConfigView = {
  dayLengthS: 600,
  warmupDays: 2,
  goalBps: 6000,
  minGoal: 5,
  closersK: 5,
  jackpotMult: 10,
  emitBps: 5,
  streakStepBps: 1000,
  streakCap: 30,
  burnBps: 500,
  slashBps: 1000,
  joinStake: 100_000n * LAST,
  memberStorageDeposit: 10n ** 22n,
  faucetAmount: 0n,
  inactiveDays: 6,
  kickBountyBps: 2000,
  potBps: 5000,
  faucetBps: 0,
  initialSupply: 10n ** 27n,
  launchNs: 1n,
  autoSettleCap: 50,
  maxSettleDays: 500,
  historyLen: 64,
};

const state: StateView = {
  today: 10,
  lastSettled: 9,
  pendingDays: 0,
  msToDayEnd: 1000,
  pot: 0n,
  reserved: 0n,
  stakePool: 0n,
  activeStake: 0n,
  jackpotPending: 0n,
  pendingHeroDays: [],
  faucetLeft: 0n,
  streak: 0,
  longestStreak: 0,
  activeCount: 0,
  membersTotal: 0,
  totalSupply: 0n,
  totalBurned: 0n,
  totalRewarded: 0n,
  totalJackpots: 0n,
};

const member: MemberView = {
  stake: 100_000n * LAST,
  joinDay: 1,
  activationDay: 3,
  lastCheckin: 9,
  resolvedThrough: 10,
  claimable: 0n,
  checkins: 5,
  personalStreak: 5,
  bestPersonalStreak: 5,
  heroCount: 0,
  storageDeposit: 10n ** 22n,
  checkinKey: null,
  effectiveStake: 100_000n * LAST,
  pendingClaimable: 0n,
  isActive: true,
  checkedInToday: false,
  canCheckInToday: true,
  currentPersonalStreak: 5,
  kickableFromDay: 16,
};

const game: GameSnapshot = { config, state, bounds: { min: 1_250n, max: 1_250n } };
const registered = { total: 1_250n, available: 0n };

function account(overrides: Partial<AccountSnapshot>): AccountSnapshot {
  return { accountId: "alice.testnet", storage: registered, balance: 0n, member: null, ...overrides };
}

function byId(actions: ReturnType<typeof accountActions>) {
  return Object.fromEntries(actions.map((action) => [action.id, action]));
}

describe("onboarding", () => {
  test("no wallet: only settle, and only when days wait", () => {
    expect(accountActions(game, null)).toEqual([]);
    const actions = accountActions({ ...game, state: { ...state, pendingDays: 2 } }, null);
    expect(actions.map((a) => a.id)).toEqual(["settle"]);
    // Found in the manual run: without a wallet there is no signer, so the button must be disabled.
    expect(actions[0]?.call).toBeUndefined();
    expect(actions[0]?.note).toBe("Connect a wallet to settle.");

    const withAccount = accountActions({ ...game, state: { ...state, pendingDays: 2 } }, account({ storage: null }));
    expect(withAccount[0]?.call?.methodName).toBe("settle");
    expect(withAccount[0]?.note).toBeUndefined();
  });

  test("an unregistered account registers with storage_balance_bounds().min", () => {
    const actions = accountActions(game, account({ storage: null }));
    expect(actions.map((a) => a.id)).toEqual(["register"]);
    expect(actions[0]?.call?.deposit).toBe("1250");
  });

  test("join needs join_stake; the faucet shows only when it is on", () => {
    const poor = byId(accountActions(game, account({ balance: 10n * LAST })));
    expect(poor.join?.call).toBeUndefined();
    expect(poor.join?.note).toBe("You have 10.00 LAST.");
    expect(poor.faucet).toBeUndefined();

    const rich = byId(
      accountActions({ ...game, config: { ...config, faucetAmount: 5n } }, account({ balance: 100_000n * LAST }))
    );
    expect(rich.join?.call?.deposit).toBe((10n ** 22n).toString());
    expect(rich.faucet?.call?.methodName).toBe("faucet");
  });
});

describe("member", () => {
  test("an active member who has not checked in can check in; leave warns about the fee", () => {
    const actions = byId(accountActions(game, account({ member })));
    expect(actions.checkIn?.call?.methodName).toBe("check_in");
    expect(actions.claim?.call).toBeUndefined();
    expect(actions.leave?.note).toContain("Exit fee 10,000.00 LAST");
  });

  test("already checked in, or in warm-up", () => {
    const checked = byId(accountActions(game, account({ member: { ...member, checkedInToday: true } })));
    expect(checked.checkIn?.call).toBeUndefined();
    expect(checked.checkIn?.note).toBe("Already checked in today.");
    expect(checked.leave?.note).toContain("No exit fee");

    const warm = byId(accountActions(game, account({ member: { ...member, isActive: false, activationDay: 12 } })));
    expect(warm.checkIn?.note).toBe("Warm-up: check-ins open on day 12.");
  });

  test("claim shows the pending amount", () => {
    const actions = byId(accountActions(game, account({ member: { ...member, pendingClaimable: 3n * LAST } })));
    expect(actions.claim?.label).toBe("Claim 3.00 LAST");
    expect(actions.claim?.call?.deposit).toBe("1");
  });

  test("a backlog above auto_settle_cap blocks game calls and makes settle required", () => {
    const backlog = { ...game, state: { ...state, pendingDays: 51 } };
    const actions = byId(accountActions(backlog, account({ member: { ...member, pendingClaimable: 1n } })));
    expect(actions.settle?.note).toContain("Required");
    expect(actions.checkIn?.call).toBeUndefined();
    expect(actions.claim?.call).toBeUndefined();
    expect(actions.leave?.call).toBeUndefined();

    const atCap = byId(accountActions({ ...game, state: { ...state, pendingDays: 50 } }, account({ member })));
    expect(atCap.checkIn?.call).toBeDefined();
  });
});

test("exit fee follows the contract: floor(stake × slash_bps / 10 000), 0 when checked in or in warm-up", () => {
  expect(exitFee(config, { ...member, effectiveStake: 999n })).toBe(99n);
  expect(exitFee(config, { ...member, checkedInToday: true })).toBe(0n);
  expect(exitFee(config, { ...member, isActive: false })).toBe(0n);
});
