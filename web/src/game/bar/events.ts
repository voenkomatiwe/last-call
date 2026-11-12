// Pure mapping from polled contract snapshots to what the bar scene shows (LC-021). No DOM, no
// Next.js: the scene engine and the tests import it.

import type { MemberView, OpenDayView, StateView } from "../../contract/views";

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
