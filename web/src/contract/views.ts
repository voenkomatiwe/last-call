import {
  asAccountId,
  asArray,
  asBool,
  asObject,
  asSafeU64Number,
  asString,
  asU32,
  asU64String,
  asU128,
  ContractShapeError,
  nullable,
} from "./decode";

// Typed results of the contract's view methods. Field names and JSON shapes follow
// `contract/src/types.rs` and `contract/src/config.rs`; meanings are in `contract/API.md`.
// Token and yoctoNEAR amounts are `bigint`.

/** Reads one field of a view object with a reader; the path names the field in errors. */
function field<T>(
  object: Record<string, unknown>,
  path: string,
  name: string,
  read: (value: unknown, path: string) => T
): T {
  if (!(name in object)) throw new ContractShapeError(`${path}.${name}: missing`);
  return read(object[name], `${path}.${name}`);
}

export interface StateView {
  readonly today: number;
  readonly lastSettled: number | null;
  readonly pendingDays: number;
  readonly msToDayEnd: number;
  readonly pot: bigint;
  readonly reserved: bigint;
  readonly stakePool: bigint;
  readonly activeStake: bigint;
  readonly jackpotPending: bigint;
  readonly pendingHeroDays: readonly number[];
  readonly faucetLeft: bigint;
  readonly streak: number;
  readonly longestStreak: number;
  readonly activeCount: number;
  readonly membersTotal: number;
  readonly totalSupply: bigint;
  readonly totalBurned: bigint;
  readonly totalRewarded: bigint;
  readonly totalJackpots: bigint;
}

export function parseState(value: unknown): StateView {
  const p = "get_state";
  const o = asObject(value, p);
  return {
    today: field(o, p, "today", asU32),
    lastSettled: field(o, p, "last_settled", nullable(asU32)),
    pendingDays: field(o, p, "pending_days", asU32),
    msToDayEnd: field(o, p, "ms_to_day_end", asSafeU64Number),
    pot: field(o, p, "pot", asU128),
    reserved: field(o, p, "reserved", asU128),
    stakePool: field(o, p, "stake_pool", asU128),
    activeStake: field(o, p, "active_stake", asU128),
    jackpotPending: field(o, p, "jackpot_pending", asU128),
    pendingHeroDays: field(o, p, "pending_hero_days", (v, path) => asArray(v, path, asU32)),
    faucetLeft: field(o, p, "faucet_left", asU128),
    streak: field(o, p, "streak", asU32),
    longestStreak: field(o, p, "longest_streak", asU32),
    activeCount: field(o, p, "active_count", asU32),
    membersTotal: field(o, p, "members_total", asU32),
    totalSupply: field(o, p, "total_supply", asU128),
    totalBurned: field(o, p, "total_burned", asU128),
    totalRewarded: field(o, p, "total_rewarded", asU128),
    totalJackpots: field(o, p, "total_jackpots", asU128),
  };
}

export interface OpenDayView {
  readonly day: number;
  readonly goal: number;
  readonly count: number;
  readonly active: number;
  readonly forfeited: number;
  /** Hero candidates so far, oldest first. */
  readonly closers: readonly string[];
  readonly isIdle: boolean;
  /** The day already ended and waits to be settled. */
  readonly stale: boolean;
}

export function parseOpenDay(value: unknown): OpenDayView {
  const p = "get_open_day";
  const o = asObject(value, p);
  return {
    day: field(o, p, "day", asU32),
    goal: field(o, p, "goal", asU32),
    count: field(o, p, "count", asU32),
    active: field(o, p, "active", asU32),
    forfeited: field(o, p, "forfeited", asU32),
    closers: field(o, p, "closers", (v, path) => asArray(v, path, asAccountId)),
    isIdle: field(o, p, "is_idle", asBool),
    stale: field(o, p, "stale", asBool),
  };
}

export interface MemberView {
  readonly stake: bigint;
  readonly joinDay: number;
  readonly activationDay: number;
  readonly lastCheckin: number | null;
  readonly resolvedThrough: number;
  readonly claimable: bigint;
  readonly checkins: number;
  readonly personalStreak: number;
  readonly bestPersonalStreak: number;
  readonly heroCount: number;
  readonly storageDeposit: bigint;
  readonly checkinKey: string | null;
  readonly effectiveStake: bigint;
  readonly pendingClaimable: bigint;
  readonly isActive: boolean;
  readonly checkedInToday: boolean;
  readonly canCheckInToday: boolean;
  readonly currentPersonalStreak: number;
  readonly kickableFromDay: number | null;
}

/** `get_member` returns `null` for a non-member. */
export function parseMember(value: unknown): MemberView | null {
  if (value === null) return null;
  const p = "get_member";
  const o = asObject(value, p);
  return {
    stake: field(o, p, "stake", asU128),
    joinDay: field(o, p, "join_day", asU32),
    activationDay: field(o, p, "activation_day", asU32),
    lastCheckin: field(o, p, "last_checkin", nullable(asU32)),
    resolvedThrough: field(o, p, "resolved_through", asU32),
    claimable: field(o, p, "claimable", asU128),
    checkins: field(o, p, "checkins", asU32),
    personalStreak: field(o, p, "personal_streak", asU32),
    bestPersonalStreak: field(o, p, "best_personal_streak", asU32),
    heroCount: field(o, p, "hero_count", asU32),
    storageDeposit: field(o, p, "storage_deposit", asU128),
    checkinKey: field(o, p, "checkin_key", nullable(asString)),
    effectiveStake: field(o, p, "effective_stake", asU128),
    pendingClaimable: field(o, p, "pending_claimable", asU128),
    isActive: field(o, p, "is_active", asBool),
    checkedInToday: field(o, p, "checked_in_today", asBool),
    canCheckInToday: field(o, p, "can_check_in_today", asBool),
    currentPersonalStreak: field(o, p, "current_personal_streak", asU32),
    kickableFromDay: field(o, p, "kickable_from_day", nullable(asU32)),
  };
}

export type Outcome = "Success" | "Fail" | "Idle";

function asOutcome(value: unknown, path: string): Outcome {
  if (value === "Success" || value === "Fail" || value === "Idle") return value;
  throw new ContractShapeError(`${path}: expected Success, Fail or Idle, got ${String(value)}`);
}

export interface DaySummary {
  readonly day: number;
  readonly outcome: Outcome;
  readonly goal: number;
  readonly count: number;
  readonly streakAfter: number;
  readonly perShare: bigint;
  readonly jackpot: bigint;
  /** Filled in by the hero draw a block or two after the day is settled. */
  readonly hero: string | null;
  readonly potBurned: bigint;
  readonly stakeSlashed: bigint;
  readonly potAfter: bigint;
}

function parseDaySummary(value: unknown, p: string): DaySummary {
  const o = asObject(value, p);
  return {
    day: field(o, p, "day", asU32),
    outcome: field(o, p, "outcome", asOutcome),
    goal: field(o, p, "goal", asU32),
    count: field(o, p, "count", asU32),
    streakAfter: field(o, p, "streak_after", asU32),
    perShare: field(o, p, "per_share", asU128),
    jackpot: field(o, p, "jackpot", asU128),
    hero: field(o, p, "hero", nullable(asAccountId)),
    potBurned: field(o, p, "pot_burned", asU128),
    stakeSlashed: field(o, p, "stake_slashed", asU128),
    potAfter: field(o, p, "pot_after", asU128),
  };
}

/** `get_history`: settled days, newest first. */
export function parseHistory(value: unknown): DaySummary[] {
  return asArray(value, "get_history", parseDaySummary);
}

export interface KickablePage {
  readonly accounts: readonly string[];
  readonly nextIndex: number | null;
}

export function parseKickablePage(value: unknown): KickablePage {
  const p = "get_kickable";
  const o = asObject(value, p);
  return {
    accounts: field(o, p, "accounts", (v, path) => asArray(v, path, asAccountId)),
    nextIndex: field(o, p, "next_index", nullable(asU32)),
  };
}

export interface ConfigView {
  readonly dayLengthS: number;
  readonly warmupDays: number;
  readonly goalBps: number;
  readonly minGoal: number;
  readonly closersK: number;
  readonly jackpotMult: number;
  readonly emitBps: number;
  readonly streakStepBps: number;
  readonly streakCap: number;
  readonly burnBps: number;
  readonly slashBps: number;
  readonly joinStake: bigint;
  readonly memberStorageDeposit: bigint;
  readonly faucetAmount: bigint;
  readonly inactiveDays: number;
  readonly kickBountyBps: number;
  readonly potBps: number;
  readonly faucetBps: number;
  readonly initialSupply: bigint;
  readonly launchNs: bigint;
  readonly autoSettleCap: number;
  readonly maxSettleDays: number;
  readonly historyLen: number;
}

/** `get_config` is one flat object: the `Config` fields plus the deploy-time values. */
export function parseConfig(value: unknown): ConfigView {
  const p = "get_config";
  const o = asObject(value, p);
  return {
    dayLengthS: field(o, p, "day_length_s", asSafeU64Number),
    warmupDays: field(o, p, "warmup_days", asU32),
    goalBps: field(o, p, "goal_bps", asU32),
    minGoal: field(o, p, "min_goal", asU32),
    closersK: field(o, p, "closers_k", asU32),
    jackpotMult: field(o, p, "jackpot_mult", asU32),
    emitBps: field(o, p, "emit_bps", asU32),
    streakStepBps: field(o, p, "streak_step_bps", asU32),
    streakCap: field(o, p, "streak_cap", asU32),
    burnBps: field(o, p, "burn_bps", asU32),
    slashBps: field(o, p, "slash_bps", asU32),
    joinStake: field(o, p, "join_stake", asU128),
    memberStorageDeposit: field(o, p, "member_storage_deposit", asU128),
    faucetAmount: field(o, p, "faucet_amount", asU128),
    inactiveDays: field(o, p, "inactive_days", asU32),
    kickBountyBps: field(o, p, "kick_bounty_bps", asU32),
    potBps: field(o, p, "pot_bps", asU32),
    faucetBps: field(o, p, "faucet_bps", asU32),
    initialSupply: field(o, p, "initial_supply", asU128),
    launchNs: field(o, p, "launch_ns", asU64String),
    autoSettleCap: field(o, p, "auto_settle_cap", asU32),
    maxSettleDays: field(o, p, "max_settle_days", asU32),
    historyLen: field(o, p, "history_len", asU32),
  };
}

export interface CheckInResult {
  readonly day: number;
  /** The member's position in the day. */
  readonly n: number;
  readonly goal: number;
  /** Whether the check-in entered the closers list (hero candidates). */
  readonly inClosers: boolean;
}

/** The result of `check_in` and `check_in_signed`. */
export function parseCheckInResult(value: unknown): CheckInResult {
  const p = "CheckInResult";
  const o = asObject(value, p);
  return {
    day: field(o, p, "day", asU32),
    n: field(o, p, "n", asU32),
    goal: field(o, p, "goal", asU32),
    inClosers: field(o, p, "in_closers", asBool),
  };
}

/** `ft_balance_of`. */
export function parseBalance(value: unknown): bigint {
  return asU128(value, "ft_balance_of");
}

export interface StorageBalance {
  readonly total: bigint;
  readonly available: bigint;
}

/** `storage_balance_of`: `null` for an account without a token account. */
export function parseStorageBalance(value: unknown): StorageBalance | null {
  if (value === null) return null;
  const p = "storage_balance_of";
  const o = asObject(value, p);
  return { total: field(o, p, "total", asU128), available: field(o, p, "available", asU128) };
}

export interface StorageBalanceBounds {
  readonly min: bigint;
  readonly max: bigint | null;
}

export function parseStorageBalanceBounds(value: unknown): StorageBalanceBounds {
  const p = "storage_balance_bounds";
  const o = asObject(value, p);
  return { min: field(o, p, "min", asU128), max: field(o, p, "max", nullable(asU128)) };
}
