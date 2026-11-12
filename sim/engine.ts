// A line-by-line TypeScript model of the Last Call contract's game logic.
// Source of every formula: plan section 4.4; methods and errors: 4.5 and 4.7; validation: 4.2.
// Field names follow the Rust state (snake_case) so traces and views map one to one.
//
// Deliberately not modelled: NEAR storage deposits and gas, events, the NEP-413 signature check
// inside `check_in_signed` (LC-002 covers it), and FT storage beyond "registered or not".

export const B = 10_000n;
export const AUTO_SETTLE_CAP = 50;
export const MAX_SETTLE_DAYS = 500;
export const HISTORY_LEN = 64;
export const U128_MAX = (1n << 128n) - 1n;
const NS_PER_S = 1_000_000_000n;
const E8 = 100_000_000n;

export interface Config {
  readonly day_length_s: number;
  readonly warmup_days: number;
  readonly inactive_days: number;
  readonly goal_bps: number;
  readonly min_goal: number;
  readonly jackpot_mult: number;
  readonly emit_bps: number;
  readonly streak_step_bps: number;
  readonly streak_cap: number;
  readonly burn_bps: number;
  readonly slash_bps: number;
  readonly join_stake: bigint;
  readonly member_storage_deposit: bigint;
  readonly faucet_amount: bigint;
}

export interface NewArgs {
  readonly config: Config;
  readonly total_supply: bigint;
  readonly pot_bps: number;
  readonly faucet_bps: number;
  readonly initial_holder: string;
}

/** The blockchain context of one call: block time, block height, caller, and the receipt's seed. */
export interface Env {
  readonly tNs: bigint;
  readonly height: number;
  readonly signer: string;
  readonly seed?: Uint8Array;
}

export type Outcome = "Success" | "Fail" | "Idle";

export interface DaySummary {
  day: number;
  outcome: Outcome;
  goal: number;
  count: number;
  streak_after: number;
  per_share: bigint;
  hero: string | null;
  jackpot: bigint;
  pot_burned: bigint;
  stake_slashed: bigint;
  pot_after: bigint;
}

export interface Member {
  stake: bigint;
  join_day: number;
  activation_day: number;
  last_checkin: number | null;
  resolved_through: number;
  claimable: bigint;
  checkins: number;
  personal_streak: number;
  best_personal_streak: number;
  hero_count: number;
  checkin_key: string | null;
}

export interface OpenDay {
  day: number;
  goal: number;
  active: number;
  active_stake: bigint;
  count: number;
  checked_stake: bigint;
  forfeited: number;
}

export interface PendingHero {
  day: number;
  /** The day's goal: tickets 1..goal were handed out. */
  tickets: number;
  jackpot: bigint;
}

/** Holders of one ticket number on the last two days that wrote it (plan section 4.4). */
export interface TicketSlot {
  day: number;
  holder: string;
  prev: { day: number; holder: string } | null;
}

/** A promise the contract schedules on itself. The harness runs it in a later block. */
export interface ScheduledCall {
  method: "pick_hero";
  day: number;
}

export interface CheckInResult {
  day: number;
  n: number;
  goal: number;
  ticket: boolean;
}

export interface State {
  contract_id: string;
  config: Config;
  launch_ns: bigint;
  initial_supply: bigint;
  pot_bps: number;

  // FT ledger (NEP-141 / NEP-145, reduced to what the game touches)
  balances: Map<string, bigint>;
  total_supply: bigint;

  // buckets held on the contract's own balance (invariant I1)
  pot: bigint;
  reserved: bigint;
  stake_pool: bigint;
  faucet_left: bigint;
  jackpot_pending: bigint;

  // game
  last_settled: number | null;
  streak: number;
  longest_streak: number;
  active_count: number;
  active_stake: bigint;
  open: OpenDay;
  pending_hero: PendingHero | null;
  /** Ticket number - 1 → holders; as many slots as the largest goal ever. */
  tickets: Map<number, TicketSlot>;
  maturing: Map<number, number>;
  rewards: Map<number, { per_share: bigint; refs: number }>;
  failed_days: Set<number>;
  history: DaySummary[];
  members: Map<string, Member>;
  members_total: number;
  faucet_used: Set<string>;

  total_burned: bigint;
  total_rewarded: bigint;
  total_jackpots: bigint;

  scheduled: ScheduledCall[];
}

/** A refusal the contract would panic with: `ERR_...` codes of plan section 4.7. */
export class ContractError extends Error {
  override readonly name = "ContractError";
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Arithmetic that would overflow or underflow in Rust with `overflow-checks = true`. In the
 * contract that is a panic in every game method; here it is reported as a defect in the formulas.
 */
export class ArithmeticError extends Error {
  override readonly name = "ArithmeticError";
}

function add(a: bigint, b: bigint, what: string): bigint {
  const result = a + b;
  if (result > U128_MAX) throw new ArithmeticError(`u128 overflow in ${what}`);
  return result;
}

function sub(a: bigint, b: bigint, what: string): bigint {
  if (b > a) throw new ArithmeticError(`underflow in ${what}: ${a} - ${b}`);
  return a - b;
}

function mul(a: bigint, b: bigint, what: string): bigint {
  const result = a * b;
  if (result > U128_MAX) throw new ArithmeticError(`u128 overflow in ${what}`);
  return result;
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

/** `new` validation of plan section 4.2, except the storage-deposit bound (storage is not modelled). */
export function validateNewArgs(args: NewArgs): void {
  const c = args.config;
  const bps = [c.goal_bps, c.emit_bps, c.streak_step_bps, c.burn_bps, c.slash_bps, args.pot_bps, args.faucet_bps];
  const ok =
    bps.every((value) => Number.isInteger(value) && value >= 0 && value <= 10_000) &&
    args.pot_bps + args.faucet_bps <= 10_000 &&
    c.warmup_days >= 1 &&
    c.inactive_days >= 1 &&
    c.min_goal >= 1 &&
    c.day_length_s >= 10 &&
    c.join_stake > 0n &&
    // Guarantees budget <= pot (I8): emit × (B + cap × step) <= 10^8, computed in u128.
    BigInt(c.emit_bps) * (B + BigInt(c.streak_cap) * BigInt(c.streak_step_bps)) <= E8 &&
    args.total_supply <= U128_MAX / E8;
  if (!ok) throw new ContractError("ERR_BAD_CONFIG");
}

const isEd25519Key = (key: string) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key);

export class LastCallSim {
  private s: State;

  private constructor(state: State) {
    this.s = state;
  }

  /** `new`: mint once, keep the pot and the faucet on the contract, give the rest to the holder. */
  static deploy(env: Env, args: NewArgs): LastCallSim {
    validateNewArgs(args);
    const contractId = env.signer;
    const pot = (args.total_supply * BigInt(args.pot_bps)) / B;
    const faucetLeft = (args.total_supply * BigInt(args.faucet_bps)) / B;
    const holderShare = args.total_supply - pot - faucetLeft;

    const balances = new Map<string, bigint>([[contractId, pot + faucetLeft]]);
    balances.set(args.initial_holder, (balances.get(args.initial_holder) ?? 0n) + holderShare);

    const sim = new LastCallSim({
      contract_id: contractId,
      config: args.config,
      launch_ns: env.tNs,
      initial_supply: args.total_supply,
      pot_bps: args.pot_bps,
      balances,
      total_supply: args.total_supply,
      pot,
      reserved: 0n,
      stake_pool: 0n,
      faucet_left: faucetLeft,
      jackpot_pending: 0n,
      last_settled: null,
      streak: 0,
      longest_streak: 0,
      active_count: 0,
      active_stake: 0n,
      open: LastCallSim.emptyOpenDay(0, 0, 0, 0n),
      pending_hero: null,
      tickets: new Map(),
      maturing: new Map(),
      rewards: new Map(),
      failed_days: new Set(),
      history: [],
      members: new Map(),
      members_total: 0,
      faucet_used: new Set(),
      total_burned: 0n,
      total_rewarded: 0n,
      total_jackpots: 0n,
      scheduled: [],
    });
    return sim;
  }

  private static emptyOpenDay(day: number, goal: number, active: number, activeStake: bigint): OpenDay {
    return {
      day,
      goal,
      active,
      active_stake: activeStake,
      count: 0,
      checked_stake: 0n,
      forfeited: 0,
    };
  }

  /** Read-only access to the raw state for tests and the invariant checker. */
  get state(): Readonly<State> {
    return this.s;
  }

  get contractId(): string {
    return this.s.contract_id;
  }

  /** Promises scheduled by the calls so far; the caller runs them in a later block. */
  takeScheduled(): ScheduledCall[] {
    const scheduled = this.s.scheduled;
    this.s.scheduled = [];
    return scheduled;
  }

  // ---------------------------------------------------------------- time and atomicity

  today(env: Env): number {
    if (env.tNs < this.s.launch_ns) throw new ArithmeticError("block time is before launch");
    return Number((env.tNs - this.s.launch_ns) / (BigInt(this.s.config.day_length_s) * NS_PER_S));
  }

  /** A panic reverts the whole receipt: run the call on a copy and keep it only on success. */
  private atomic<T>(call: () => T): T {
    const before = structuredClone(this.s);
    try {
      return call();
    } catch (error) {
      this.s = before;
      throw error;
    }
  }

  private nextToSettle(): number {
    return this.s.last_settled === null ? 0 : this.s.last_settled + 1;
  }

  /** Auto-settle of the game methods: the backlog check comes before any work (plan 4.1). */
  private autoSettle(env: Env): number {
    const today = this.today(env);
    const pending = today - this.nextToSettle();
    if (pending > AUTO_SETTLE_CAP) throw new ContractError("ERR_BACKLOG");
    this.settleDays(pending);
    return today;
  }

  // ---------------------------------------------------------------- FT ledger

  private isRegistered(accountId: string): boolean {
    return this.s.balances.has(accountId);
  }

  private balance(accountId: string): bigint {
    return this.s.balances.get(accountId) ?? 0n;
  }

  private transfer(from: string, to: string, amount: bigint): void {
    if (amount === 0n) return;
    if (!this.isRegistered(to)) throw new ContractError("ERR_NOT_REGISTERED");
    this.s.balances.set(from, sub(this.balance(from), amount, `balance of ${from}`));
    this.s.balances.set(to, add(this.balance(to), amount, `balance of ${to}`));
  }

  /** `internal_withdraw` from the contract's own balance: supply goes down, never up. */
  private burn(amount: bigint): void {
    if (amount === 0n) return;
    const contract = this.s.contract_id;
    this.s.balances.set(contract, sub(this.balance(contract), amount, "contract balance (burn)"));
    this.s.total_supply = sub(this.s.total_supply, amount, "total_supply");
    this.s.total_burned = add(this.s.total_burned, amount, "total_burned");
  }

  // ---------------------------------------------------------------- days

  private openDay(day: number): void {
    const s = this.s;
    const c = s.config;
    const matured = s.maturing.get(day) ?? 0;
    s.maturing.delete(day);
    s.active_count += matured;
    s.active_stake = add(s.active_stake, mul(BigInt(matured), c.join_stake, "maturing stake"), "active_stake");

    let goal = 0;
    if (s.active_count >= c.min_goal) {
      const ceil = Number((BigInt(s.active_count) * BigInt(c.goal_bps) + B - 1n) / B);
      goal = Math.max(c.min_goal, ceil);
    }
    s.open = LastCallSim.emptyOpenDay(day, goal, s.active_count, s.active_stake);
  }

  private settleDays(days: number): void {
    const s = this.s;
    let heroDay: number | null = null;
    for (let index = 0; index < days; index += 1) {
      const day = s.open.day;
      if (day !== this.nextToSettle()) throw new ArithmeticError(`open day ${day} is not the next day to settle`);
      if (this.closeDay(day)) heroDay = day;
      s.last_settled = day;
      this.openDay(day + 1);
    }
    // At most one success per batch: only the first (stale open) day can have check-ins.
    if (heroDay !== null) s.scheduled.push({ method: "pick_hero", day: heroDay });
  }

  /** Closes the open day. Returns true when it created a pending hero draw. */
  private closeDay(day: number): boolean {
    const s = this.s;
    const c = s.config;
    const open = s.open;
    const summary: DaySummary = {
      day,
      outcome: "Idle",
      goal: open.goal,
      count: open.count,
      streak_after: s.streak,
      per_share: 0n,
      hero: null,
      jackpot: 0n,
      pot_burned: 0n,
      stake_slashed: 0n,
      pot_after: s.pot,
    };
    let heroScheduled = false;

    if (open.goal > 0 && open.count >= open.goal) {
      summary.outcome = "Success";
      s.streak += 1;
      s.longest_streak = Math.max(s.longest_streak, s.streak);
      const multBps = B + BigInt(Math.min(s.streak, c.streak_cap)) * BigInt(c.streak_step_bps);
      const budget = mul(mul(s.pot, BigInt(c.emit_bps), "budget"), multBps, "budget") / E8;
      const perShare = budget / BigInt(open.count + c.jackpot_mult);
      const shares = open.count - open.forfeited;
      if (perShare > 0n && shares > 0) {
        const reservedNow = mul(perShare, BigInt(shares), "shares");
        s.pot = sub(s.pot, reservedNow, "pot (shares)");
        s.reserved = add(s.reserved, reservedNow, "reserved");
        s.total_rewarded = add(s.total_rewarded, reservedNow, "total_rewarded");
        s.rewards.set(day, { per_share: perShare, refs: shares });
      }
      const jackpot = mul(perShare, BigInt(c.jackpot_mult), "jackpot");
      if (jackpot > 0n) {
        const expired = s.pending_hero;
        if (expired) {
          // The previous pick_hero never ran: its jackpot goes back to the pot (jackpot_expired).
          s.jackpot_pending = sub(s.jackpot_pending, expired.jackpot, "jackpot_pending (expired)");
          s.pot = add(s.pot, expired.jackpot, "pot (expired jackpot)");
        }
        s.pot = sub(s.pot, jackpot, "pot (jackpot)");
        s.jackpot_pending = add(s.jackpot_pending, jackpot, "jackpot_pending");
        s.pending_hero = { day, tickets: open.goal, jackpot };
        heroScheduled = true;
      }
      summary.per_share = perShare;
      summary.jackpot = jackpot;
    } else if (open.goal > 0) {
      summary.outcome = "Fail";
      s.streak = 0;
      const potBurn = (s.pot * BigInt(c.burn_bps)) / B;
      s.pot = sub(s.pot, potBurn, "pot (burn)");
      const unchecked = sub(open.active_stake, open.checked_stake, "open.active_stake - open.checked_stake");
      const slash = minBig((unchecked * BigInt(c.slash_bps)) / B, s.active_stake);
      s.stake_pool = sub(s.stake_pool, slash, "stake_pool (slash)");
      s.active_stake = sub(s.active_stake, slash, "active_stake (slash)");
      this.burn(add(potBurn, slash, "burn"));
      s.failed_days.add(day);
      summary.pot_burned = potBurn;
      summary.stake_slashed = slash;
    }

    summary.streak_after = s.streak;
    summary.pot_after = s.pot;
    s.history.push(summary);
    if (s.history.length > HISTORY_LEN) s.history.shift();
    return heroScheduled;
  }

  // ---------------------------------------------------------------- members

  /** What `resolve(a, t)` would change, without changing anything. */
  private previewResolve(member: Member, t: number) {
    const s = this.s;
    const c = s.config;
    const p = member.last_checkin;
    let claimable = member.claimable;
    let rewardDay: number | null = null;
    if (p !== null && p < t && p >= member.resolved_through) {
      const reward = s.rewards.get(p);
      if (reward) {
        claimable = add(claimable, reward.per_share, "claimable");
        rewardDay = p;
      }
    }

    const from = Math.max(member.resolved_through, member.activation_day);
    let missedFails = 0;
    for (let day = from; day < t; day += 1) if (s.failed_days.has(day)) missedFails += 1;
    if (p !== null && p >= from && p < t && s.failed_days.has(p)) missedFails -= 1;

    let stake = member.stake;
    // Remainder rounded down: the member loses the ceil, so the sum of stakes stays <= the pool.
    for (let index = 0; index < missedFails; index += 1) stake = (stake * (B - BigInt(c.slash_bps))) / B;
    return { stake, claimable, rewardDay };
  }

  private resolve(member: Member, t: number): void {
    const preview = this.previewResolve(member, t);
    if (preview.rewardDay !== null) {
      const reward = this.s.rewards.get(preview.rewardDay);
      if (!reward) throw new ArithmeticError("reward vanished during resolve");
      reward.refs -= 1;
      if (reward.refs === 0) this.s.rewards.delete(preview.rewardDay);
    }
    member.stake = preview.stake;
    member.claimable = preview.claimable;
    member.resolved_through = Math.max(member.resolved_through, t);
  }

  private member(accountId: string): Member {
    const member = this.s.members.get(accountId);
    if (!member) throw new ContractError("ERR_NOT_MEMBER");
    return member;
  }

  // ---------------------------------------------------------------- game methods

  join(env: Env, checkinKey: string | null = null): void {
    this.atomic(() => {
      const s = this.s;
      const c = s.config;
      const today = this.autoSettle(env);
      const accountId = env.signer;
      if (s.members.has(accountId)) throw new ContractError("ERR_ALREADY_MEMBER");
      if (checkinKey !== null && !isEd25519Key(checkinKey)) throw new ContractError("ERR_BAD_KEY");
      if (!this.isRegistered(accountId)) throw new ContractError("ERR_NOT_REGISTERED");
      if (this.balance(accountId) < c.join_stake) throw new ContractError("ERR_INSUFFICIENT_BALANCE");

      this.transfer(accountId, s.contract_id, c.join_stake);
      s.stake_pool = add(s.stake_pool, c.join_stake, "stake_pool");
      const activationDay = today + c.warmup_days;
      s.maturing.set(activationDay, (s.maturing.get(activationDay) ?? 0) + 1);
      s.members_total += 1;
      s.members.set(accountId, {
        stake: c.join_stake,
        join_day: today,
        activation_day: activationDay,
        last_checkin: null,
        resolved_through: today,
        claimable: 0n,
        checkins: 0,
        personal_streak: 0,
        best_personal_streak: 0,
        hero_count: 0,
        checkin_key: checkinKey,
      });
    });
  }

  checkIn(env: Env): CheckInResult {
    return this.atomic(() => {
      const today = this.autoSettle(env);
      return this.checkInMember(env.signer, today);
    });
  }

  /** The signature itself is not checked here: LC-002 covers it. Day and key checks are. */
  checkInSigned(env: Env, accountId: string, day: number): CheckInResult {
    return this.atomic(() => {
      const today = this.autoSettle(env);
      const member = this.member(accountId);
      if (member.checkin_key === null) throw new ContractError("ERR_NO_CHECKIN_KEY");
      if (day !== today) throw new ContractError("ERR_BAD_DAY");
      return this.checkInMember(accountId, today);
    });
  }

  private checkInMember(accountId: string, today: number): CheckInResult {
    const s = this.s;
    const open = s.open;
    const member = this.member(accountId);
    if (member.activation_day > today) throw new ContractError("ERR_WARMUP");
    if (member.last_checkin === today) throw new ContractError("ERR_ALREADY_CHECKED_IN");

    this.resolve(member, today);
    member.personal_streak = member.last_checkin === today - 1 ? member.personal_streak + 1 : 1;
    member.best_personal_streak = Math.max(member.best_personal_streak, member.personal_streak);
    open.count += 1;
    open.checked_stake = add(open.checked_stake, member.stake, "checked_stake");
    member.last_checkin = today;
    member.checkins += 1;

    // Every check-in numbered up to the goal gets a ticket, whatever the block (decision 12.11).
    let ticket = false;
    if (open.goal > 0 && open.count <= open.goal) {
      const index = open.count - 1;
      const slot = s.tickets.get(index);
      s.tickets.set(index, {
        day: today,
        holder: accountId,
        prev: slot ? { day: slot.day, holder: slot.holder } : null,
      });
      ticket = true;
    }
    return { day: today, n: open.count, goal: open.goal, ticket };
  }

  setCheckinKey(env: Env, key: string | null): void {
    this.atomic(() => {
      const member = this.member(env.signer);
      if (key !== null && !isEd25519Key(key)) throw new ContractError("ERR_BAD_KEY");
      member.checkin_key = key;
    });
  }

  /** Anyone may settle up to `max_days` (capped at MAX_SETTLE_DAYS). Returns the days settled. */
  settle(env: Env, maxDays: number | null = null): number {
    return this.atomic(() => {
      const pending = this.today(env) - this.nextToSettle();
      const days = Math.min(pending, Math.min(maxDays ?? MAX_SETTLE_DAYS, MAX_SETTLE_DAYS));
      this.settleDays(days);
      return days;
    });
  }

  claim(env: Env): bigint {
    return this.atomic(() => {
      const s = this.s;
      const today = this.autoSettle(env);
      const member = this.member(env.signer);
      this.resolve(member, today);
      const amount = member.claimable;
      if (amount === 0n) throw new ContractError("ERR_NOTHING_TO_CLAIM");
      member.claimable = 0n;
      s.reserved = sub(s.reserved, amount, "reserved (claim)");
      this.transfer(s.contract_id, env.signer, amount);
      return amount;
    });
  }

  leave(env: Env): bigint {
    return this.atomic(() => {
      const today = this.autoSettle(env);
      return this.exit(env.signer, today);
    });
  }

  kick(env: Env, accountId: string): bigint {
    return this.atomic(() => {
      const today = this.autoSettle(env);
      const member = this.member(accountId);
      const since = member.last_checkin === null ? member.activation_day : member.last_checkin + 1;
      if (!(member.activation_day <= today && today >= since + this.s.config.inactive_days)) {
        throw new ContractError("ERR_NOT_INACTIVE");
      }
      return this.exit(accountId, today);
    });
  }

  /**
   * The shared part of `leave` and `kick`. Returns what reached the member: claimable plus the
   * stake minus the fee. (The plan names the return value only loosely; see the task evidence.)
   */
  private exit(accountId: string, today: number): bigint {
    const s = this.s;
    const c = s.config;
    const member = this.member(accountId);
    this.resolve(member, today);

    const claimable = member.claimable;
    s.reserved = sub(s.reserved, claimable, "reserved (exit)");
    this.transfer(s.contract_id, accountId, claimable);

    let fee = 0n;
    if (member.activation_day <= today) {
      const checked = member.last_checkin === today;
      fee = checked ? 0n : (member.stake * BigInt(c.slash_bps)) / B;
      s.active_count -= 1;
      // The contract uses saturating_sub here and a checked subtraction in its tests (I3).
      if (s.active_stake < member.stake || s.open.active_stake < member.stake) {
        throw new ArithmeticError("I3 violated: a member's stake exceeds the active aggregate");
      }
      s.active_stake -= member.stake;
      s.open.active_stake -= member.stake;
      if (checked) {
        s.open.checked_stake = sub(s.open.checked_stake, member.stake, "open.checked_stake (exit)");
        s.open.forfeited += 1;
      }
    } else {
      const remaining = (s.maturing.get(member.activation_day) ?? 0) - 1;
      if (remaining < 0) throw new ArithmeticError("maturing count went negative");
      if (remaining === 0) s.maturing.delete(member.activation_day);
      else s.maturing.set(member.activation_day, remaining);
    }

    s.stake_pool = sub(s.stake_pool, member.stake, "stake_pool (exit)");
    this.burn(fee);
    const returned = member.stake - fee;
    this.transfer(s.contract_id, accountId, returned);

    s.members_total -= 1;
    s.members.delete(accountId);
    if (s.members_total === 0) {
      // Dust goes to the pot; open.* too, or a later slash of dust would underflow forever.
      s.pot = add(s.pot, s.stake_pool, "pot (dust)");
      s.stake_pool = 0n;
      s.active_stake = 0n;
      s.open.active_stake = 0n;
      s.open.checked_stake = 0n;
    }
    return claimable + returned;
  }

  /** Holder of ticket `index + 1` on `day`: the slot's current or previous generation. */
  private ticketHolder(index: number, day: number): string | null {
    const slot = this.s.tickets.get(index);
    if (slot?.day === day) return slot.holder;
    if (slot?.prev?.day === day) return slot.prev.holder;
    return null;
  }

  /** `#[private]`: only the contract's own promise may call it, in a later block. */
  pickHero(env: Env, day: number): void {
    this.atomic(() => {
      const s = this.s;
      if (env.signer !== s.contract_id) throw new ContractError("ERR_PRIVATE");
      const pending = s.pending_hero;
      if (!pending || pending.day !== day) return;
      if (env.seed?.length !== 32) throw new ArithmeticError("pick_hero needs a 32-byte seed");
      s.pending_hero = null;

      if (pending.tickets < 1) throw new ArithmeticError("a successful day has no tickets");
      const hero = this.ticketHolder(heroIndex(env.seed, day, pending.tickets), day);
      s.jackpot_pending = sub(s.jackpot_pending, pending.jackpot, "jackpot_pending (pick_hero)");
      if (hero === null) {
        // The slot was rewritten by two newer days: nobody can be paid (jackpot_expired).
        s.pot = add(s.pot, pending.jackpot, "pot (lost ticket)");
      } else if (this.isRegistered(hero)) {
        this.transfer(s.contract_id, hero, pending.jackpot);
        s.total_jackpots = add(s.total_jackpots, pending.jackpot, "total_jackpots");
        const member = s.members.get(hero);
        if (member) member.hero_count += 1;
      } else {
        s.pot = add(s.pot, pending.jackpot, "pot (unregistered hero)");
      }
      const summary = s.history.find((entry) => entry.day === day);
      if (summary && hero !== null) summary.hero = hero;
    });
  }

  faucet(env: Env): bigint {
    return this.atomic(() => {
      const s = this.s;
      const amount = s.config.faucet_amount;
      if (amount === 0n) throw new ContractError("ERR_FAUCET_DISABLED");
      if (s.faucet_used.has(env.signer)) throw new ContractError("ERR_FAUCET_USED");
      if (s.faucet_left < amount) throw new ContractError("ERR_FAUCET_EMPTY");
      if (!this.isRegistered(env.signer)) throw new ContractError("ERR_NOT_REGISTERED");
      s.faucet_left -= amount;
      s.faucet_used.add(env.signer);
      this.transfer(s.contract_id, env.signer, amount);
      return amount;
    });
  }

  // ---------------------------------------------------------------- NEP-141 / NEP-145 subset

  storageDeposit(_env: Env, accountId: string): void {
    this.atomic(() => {
      if (!this.isRegistered(accountId)) this.s.balances.set(accountId, 0n);
    });
  }

  storageUnregister(env: Env): void {
    this.atomic(() => {
      if (this.s.members.has(env.signer)) throw new ContractError("ERR_MEMBER_CANNOT_UNREGISTER");
      if (!this.isRegistered(env.signer)) throw new ContractError("ERR_NOT_REGISTERED");
      if (this.balance(env.signer) > 0n) throw new ContractError("ERR_NONZERO_BALANCE");
      this.s.balances.delete(env.signer);
    });
  }

  ftTransfer(env: Env, receiverId: string, amount: bigint): void {
    this.atomic(() => {
      if (receiverId === this.s.contract_id) throw new ContractError("ERR_USE_JOIN");
      if (amount <= 0n) throw new ContractError("ERR_ZERO_AMOUNT");
      if (!this.isRegistered(env.signer)) throw new ContractError("ERR_NOT_REGISTERED");
      if (this.balance(env.signer) < amount) throw new ContractError("ERR_INSUFFICIENT_BALANCE");
      this.transfer(env.signer, receiverId, amount);
    });
  }

  // ---------------------------------------------------------------- views

  ftBalanceOf(accountId: string): bigint {
    return this.balance(accountId);
  }

  ftTotalSupply(): bigint {
    return this.s.total_supply;
  }

  getState(env: Env) {
    const s = this.s;
    const today = this.today(env);
    const dayNs = BigInt(s.config.day_length_s) * NS_PER_S;
    const dayEndNs = s.launch_ns + BigInt(today + 1) * dayNs;
    return {
      today,
      last_settled: s.last_settled,
      pending_days: today - this.nextToSettle(),
      pot: s.pot,
      reserved: s.reserved,
      stake_pool: s.stake_pool,
      faucet_left: s.faucet_left,
      jackpot_pending: s.jackpot_pending,
      streak: s.streak,
      longest_streak: s.longest_streak,
      active_count: s.active_count,
      members_total: s.members_total,
      total_supply: s.total_supply,
      total_burned: s.total_burned,
      total_rewarded: s.total_rewarded,
      total_jackpots: s.total_jackpots,
      ms_to_day_end: Number((dayEndNs - env.tNs) / 1_000_000n),
    };
  }

  getOpenDay(env: Env) {
    const open = this.s.open;
    return {
      day: open.day,
      goal: open.goal,
      count: open.count,
      active: open.active,
      forfeited: open.forfeited,
      tickets: open.goal > 0 ? Math.min(open.count, open.goal) : 0,
      is_idle: open.goal === 0,
      stale: open.day < this.today(env),
    };
  }

  /** The latest summaries, newest first, at most HISTORY_LEN. */
  getHistory(limit: number): DaySummary[] {
    return this.s.history
      .slice()
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((summary) => ({ ...summary }));
  }

  getMember(env: Env, accountId: string) {
    const member = this.s.members.get(accountId);
    if (!member) return null;
    const today = this.today(env);
    const preview = this.previewResolve(member, this.s.open.day);
    const since = member.last_checkin === null ? member.activation_day : member.last_checkin + 1;
    return {
      ...member,
      effective_stake: preview.stake,
      pending_claimable: preview.claimable,
      can_check_in_today: member.activation_day <= today && member.last_checkin !== today,
      checked_in_today: member.last_checkin === today,
      kickable_from_day: since + this.s.config.inactive_days,
    };
  }

  /** Members a kick applies to right now, scanning `limit` entries from `fromIndex`. */
  getKickable(env: Env, fromIndex: number, limit: number): string[] {
    const today = this.today(env);
    const inactiveDays = this.s.config.inactive_days;
    return [...this.s.members.entries()]
      .slice(fromIndex, fromIndex + limit)
      .filter(([, member]) => {
        const since = member.last_checkin === null ? member.activation_day : member.last_checkin + 1;
        return member.activation_day <= today && today >= since + inactiveDays;
      })
      .map(([accountId]) => accountId);
  }

  /** `effective_stake` and `pending_claimable` of every member, as `get_member` reports them. */
  effectiveMembers(): Array<{ accountId: string; member: Member; stake: bigint; claimable: bigint }> {
    return [...this.s.members.entries()].map(([accountId, member]) => {
      const preview = this.previewResolve(member, this.s.open.day);
      return { accountId, member, stake: preview.stake, claimable: preview.claimable };
    });
  }
}

/** `sha256(seed ‖ day as u32 little-endian ‖ "lastcall")`, first 8 bytes as u64 little-endian, mod n. */
export function heroIndex(seed: Uint8Array, day: number, tickets: number): number {
  const dayBytes = new Uint8Array(4);
  new DataView(dayBytes.buffer).setUint32(0, day, true);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(seed);
  hasher.update(dayBytes);
  hasher.update(new TextEncoder().encode("lastcall"));
  const digest = new Uint8Array(hasher.digest().buffer);
  const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, true);
  return Number(value % BigInt(tickets));
}
