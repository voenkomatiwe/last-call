// How the bar grows with the player (LC-028). Pure: the scene, the hall and the tests import it.
//
// Tiers follow the personal streak (`current_personal_streak`): it is the player's own record and the
// thing they lose by skipping a night. The reward multiplier is a different number: the contract
// multiplies the day's budget by the community streak (`get_state().streak`), so the hall shows it
// next to the pot, never next to the personal streak.

export type TierId = "novice" | "guest" | "regular" | "local" | "legend" | "owner";

export interface Tier {
  readonly id: TierId;
  /** 0 (novice) … 5 (owner). */
  readonly index: number;
  /** On-screen name. */
  readonly name: string;
  /** Lowest personal streak of this tier. */
  readonly from: number;
  /** Streak where the next tier starts; `null` for the top tier. */
  readonly next: number | null;
}

const TIERS: readonly Omit<Tier, "index" | "next">[] = [
  { id: "novice", name: "New face", from: 0 },
  { id: "guest", name: "Guest", from: 1 },
  { id: "regular", name: "Regular", from: 3 },
  { id: "local", name: "Local", from: 7 },
  { id: "legend", name: "Legend", from: 14 },
  { id: "owner", name: "Owner", from: 30 },
];

export const TIER_COUNT = TIERS.length;

/** The tier of a personal streak. Negative or fractional input is treated as the whole days below it. */
export function streakTier(streak: number): Tier {
  const s = Math.max(0, Math.floor(streak));
  let index = 0;
  for (let i = 1; i < TIERS.length; i++) if (s >= (TIERS[i] as (typeof TIERS)[number]).from) index = i;
  const tier = TIERS[index] as (typeof TIERS)[number];
  const next = TIERS[index + 1];
  return { ...tier, index, next: next ? next.from : null };
}

/** Nights still needed to reach the next tier; `null` at the top. */
export function nightsToNextTier(streak: number): number | null {
  const tier = streakTier(streak);
  return tier.next === null ? null : tier.next - Math.max(0, Math.floor(streak));
}

/**
 * The contract's streak multiplier in basis points: `10 000 + min(streak, streak_cap) × streak_step_bps`
 * (`contract/API.md`, Parameters). `streak` is the community streak counting the day being paid, so
 * for tonight's rewards pass `state.streak + 1`.
 */
export function streakMultiplierBps(streak: number, streakStepBps: number, streakCap: number): number {
  return 10_000 + Math.min(Math.max(0, streak), streakCap) * streakStepBps;
}

/** "×1.3": one decimal, two when the second one matters (×1.25). */
export function formatMultiplier(bps: number): string {
  const x = bps / 10_000;
  const one = x.toFixed(1);
  return `×${Number(one) === x ? one : x.toFixed(2)}`;
}

/** Share of the night after which an open streak counts as at risk. */
export const RISK_SHARE = 0.15;

/** The player has a streak to lose, has not checked in, and less than 15% of the night is left. */
export function streakAtRisk(args: {
  readonly streak: number;
  readonly checkedInToday: boolean;
  readonly msLeft: number;
  readonly dayLengthMs: number;
}): boolean {
  return args.streak > 0 && !args.checkedInToday && args.msLeft < args.dayLengthMs * RISK_SHARE;
}

/** The one thing the screen asks the player to do now. */
export type PrimaryAction =
  /** Drink: the glass glows, the ghost hand shows the gesture. */
  | "drink"
  /** Finished days must be settled before anyone can check in. */
  | "settle"
  /** Rewards wait in the tab. */
  | "claim"
  /** Nothing to do (warm-up, or done and nothing to claim). */
  | "none";

export function primaryAction(args: {
  readonly mode: "warmup" | "ready" | "done-today" | "backlog";
  readonly claimable: bigint;
}): PrimaryAction {
  if (args.mode === "backlog") return "settle";
  if (args.mode === "ready") return "drink";
  if (args.claimable > 0n) return "claim";
  return "none";
}
