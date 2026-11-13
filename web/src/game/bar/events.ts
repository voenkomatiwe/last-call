// Pure mapping from polled contract snapshots to what the bar scene shows (LC-021). No DOM, no
// Next.js: the scene engine and the tests import it.

import type { DaySummary, MemberView, OpenDayView, StateView } from "../../contract/views";

/** What the player's glass does now. */
export type BarMode =
  /** The member's activation day has not come: the glass is empty, the bartender explains. */
  | "warmup"
  /** A full drink sends the check-in. */
  | "ready"
  /** Already checked in today: a glass "on the house", no transaction. */
  | "done-today"
  /** Finished days wait to be settled; the contract refuses check-ins (`ERR_BACKLOG`). */
  | "backlog";

export function barMode(member: MemberView, backlog: boolean): BarMode {
  if (member.checkedInToday) return "done-today";
  if (!member.isActive) return "warmup";
  if (backlog) return "backlog";
  return "ready";
}

/** The day as the bar shows it. */
export interface BarDay {
  readonly day: number;
  readonly count: number;
  /** `null` while the day has not been opened on chain yet (the previous day waits to be settled). */
  readonly goal: number | null;
  readonly isIdle: boolean;
  /** Hero candidates so far, oldest first (`OpenDayView.closers`). */
  readonly closers: readonly string[];
}

/**
 * The live day. When `openDay` is stale it describes a finished day; today then has no check-ins
 * yet and its goal is fixed only when the first call of the day opens it.
 */
export function barDay(state: StateView, openDay: OpenDayView): BarDay {
  if (openDay.stale) return { day: state.today, count: 0, goal: null, isIdle: false, closers: [] };
  return {
    day: openDay.day,
    count: openDay.count,
    goal: openDay.isIdle ? null : openDay.goal,
    isIdle: openDay.isIdle,
    closers: openDay.closers,
  };
}

/** One poll's view of the day and of the player. */
export interface BarSnapshot {
  readonly day: BarDay;
  /** The connected member's `checked_in_today`; `false` without a member. */
  readonly checkedInToday: boolean;
  readonly accountId: string | null;
}

export type BarEvent =
  | { readonly kind: "new-day"; readonly day: number }
  /** Other accounts checked in since the previous poll; `names` are the ones known from the closers list. */
  | { readonly kind: "others-checked-in"; readonly count: number; readonly names: readonly string[] }
  | { readonly kind: "goal-reached"; readonly day: number };

/**
 * Scene events between two consecutive polls. The first poll produces none: the scene starts in the
 * state it reads. The player's own check-in is not an "other" check-in: it is recognised by
 * `checked_in_today` turning true in the same day.
 */
export function sceneEvents(prev: BarSnapshot | null, next: BarSnapshot): BarEvent[] {
  if (!prev) return [];
  if (next.day.day !== prev.day.day) {
    // A new day starts from zero; check-ins made before the first poll of the day are not replayed.
    return next.day.day > prev.day.day ? [{ kind: "new-day", day: next.day.day }] : [];
  }
  const events: BarEvent[] = [];
  const own = !prev.checkedInToday && next.checkedInToday ? 1 : 0;
  const others = next.day.count - prev.day.count - own;
  if (others > 0) {
    const known = new Set(prev.day.closers);
    const names = next.day.closers.filter((name) => !known.has(name) && name !== next.accountId);
    events.push({ kind: "others-checked-in", count: others, names: names.slice(-others) });
  }
  const goal = next.day.goal;
  if (goal !== null && !next.day.isIdle && prev.day.count < goal && next.day.count >= goal) {
    events.push({ kind: "goal-reached", day: next.day.day });
  }
  return events;
}

/** Past this personal streak the HUD and buttons start to blur and sway (prototype `drunkUiFromStreak`). */
export const DRUNK_FROM_STREAK = 7;

/** 0 below the threshold, then 0.35 rising to 1 over ten more days. */
export function drunkLevel(streak: number, from = DRUNK_FROM_STREAK): number {
  return streak >= from ? Math.min(1, 0.35 + (0.65 * (streak - from)) / 10) : 0;
}

// ---------- LC-025: the day's moments from settled days ----------

export type HistoryEvent =
  /** A day was settled since the previous poll: coins on success, smoke and a dead letter on failure. */
  | { readonly kind: "day-settled"; readonly summary: DaySummary }
  /** A settled day's hero draw landed (`hero` turned from `null` to an account). */
  | { readonly kind: "hero-picked"; readonly day: number; readonly hero: string; readonly jackpot: bigint };

/**
 * Moments between two polls of `get_history` (newest first, any order accepted). The first poll
 * produces none. A day newer than every day seen before is "settled"; a hero shows up either on a
 * day seen without one, or already drawn on a newly settled day. Idle days settle quietly.
 */
export function historyEvents(prev: readonly DaySummary[] | null, next: readonly DaySummary[]): HistoryEvent[] {
  if (!prev) return [];
  const before = new Map(prev.map((d) => [d.day, d]));
  const newest = prev.reduce((max, d) => Math.max(max, d.day), -1);
  const events: HistoryEvent[] = [];
  for (const d of [...next].sort((a, b) => a.day - b.day)) {
    const old = before.get(d.day);
    if (!old && d.day > newest && d.outcome !== "Idle") events.push({ kind: "day-settled", summary: d });
    if (d.hero !== null && (old ? old.hero === null : d.day > newest)) {
      events.push({ kind: "hero-picked", day: d.day, hero: d.hero, jackpot: d.jackpot });
    }
  }
  return events;
}

/** The neon sign; failed days kill its letters one by one, in this order, for good. */
export const SIGN = "LAST CALL";
const DEATH_ORDER = [5, 8, 1, 6, 3, 7, 0, 2] as const;

/** Failed days in the read history. The history is capped (`history_len`), so this is "for good" within it. */
export function failedDays(history: readonly DaySummary[]): number {
  return history.filter((d) => d.outcome === "Fail").length;
}

/** Indexes into `SIGN` whose letters are dead after `fails` failed days. */
export function deadLetters(fails: number): ReadonlySet<number> {
  return new Set(DEATH_ORDER.slice(0, Math.max(0, fails)));
}

/** The pot at launch: `initial_supply × pot_bps / 10 000`. */
export function initialPot(initialSupply: bigint, potBps: number): bigint {
  return (initialSupply * BigInt(potBps)) / 10_000n;
}

/** How full the coin jar is, 0..1, as the pot against its launch size; a non-empty pot never looks empty. */
export function jarLevel(pot: bigint, initial: bigint): number {
  if (pot <= 0n) return 0;
  if (initial <= 0n || pot >= initial) return 1;
  return Math.max(0.04, Number((pot * 10_000n) / initial) / 10_000);
}

/** Today's closers as the bar seats them: the player apart, everyone else oldest first. */
export function seatClosers(
  closers: readonly string[],
  self: string | null
): { readonly others: readonly string[]; readonly self: boolean } {
  return { others: closers.filter((c) => c !== self), self: self !== null && closers.includes(self) };
}
