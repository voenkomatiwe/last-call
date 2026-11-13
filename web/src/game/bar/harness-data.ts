import type { ConfigView, DaySummary, MemberView, StateView } from "../../contract/views";
import type { GameData } from "../use-game";
import type { BarDay } from "./events";

// Synthetic contract views for `/dev/bar?hall`: the hall's layout without a wallet or a chain.

const LAST = 10n ** 18n;

const config: ConfigView = {
  dayLengthS: 600,
  warmupDays: 2,
  goalBps: 6000,
  minGoal: 5,
  closersK: 3,
  jackpotMult: 10,
  emitBps: 500,
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

function history(today: number): DaySummary[] {
  return Array.from({ length: 8 }, (_, i) => {
    const day = today - 1 - i;
    const outcome = i === 2 ? "Fail" : i === 6 ? "Idle" : "Success";
    return {
      day,
      outcome,
      goal: 6,
      count: outcome === "Fail" ? 4 : 7,
      streakAfter: 0,
      perShare: outcome === "Success" ? 2_380n * LAST : 0n,
      jackpot: outcome === "Success" && i % 2 === 0 ? 23_810n * LAST : 0n,
      hero: outcome === "Success" && i % 2 === 0 ? "kai.testnet" : null,
      potBurned: outcome === "Fail" ? 24_100_000n * LAST : 0n,
      stakeSlashed: outcome === "Fail" ? 30_000n * LAST : 0n,
      potAfter: 482_000_000n * LAST,
    } satisfies DaySummary;
  });
}

export function harnessData(day: BarDay, checkedIn: boolean, streak: number, readAt: number): GameData {
  const state: StateView = {
    today: day.day,
    lastSettled: day.day - 1,
    pendingDays: 0,
    msToDayEnd: 7 * 60_000 + 42_000,
    pot: 482_019_334n * LAST,
    reserved: 0n,
    stakePool: 0n,
    activeStake: 0n,
    jackpotPending: 0n,
    pendingHeroDays: [],
    faucetLeft: 0n,
    streak: 12,
    longestStreak: 19,
    activeCount: 10,
    membersTotal: 11,
    totalSupply: 10n ** 27n,
    totalBurned: 48_200_000n * LAST,
    totalRewarded: 0n,
    totalJackpots: 0n,
  };
  const member: MemberView = {
    stake: 100_000n * LAST,
    joinDay: 1,
    activationDay: 3,
    lastCheckin: checkedIn ? day.day : day.day - 1,
    resolvedThrough: day.day,
    claimable: 0n,
    checkins: 9,
    personalStreak: streak,
    bestPersonalStreak: Math.max(streak, 11),
    heroCount: 1,
    storageDeposit: 10n ** 22n,
    checkinKey: null,
    effectiveStake: 100_000n * LAST,
    pendingClaimable: 7_140n * LAST,
    isActive: true,
    checkedInToday: checkedIn,
    canCheckInToday: !checkedIn,
    currentPersonalStreak: streak,
    kickableFromDay: checkedIn ? null : day.day + 5,
  };
  return {
    game: { config, state, bounds: { min: 1_250n, max: 1_250n } },
    openDay: {
      day: day.day,
      goal: day.goal ?? 6,
      count: day.count,
      active: 10,
      forfeited: 0,
      closers: day.closers,
      isIdle: day.isIdle,
      stale: false,
    },
    history: history(day.day),
    account: { accountId: "you.test", storage: { total: 1_250n, available: 0n }, balance: 3_000n * LAST, member },
    readAt,
  };
}
