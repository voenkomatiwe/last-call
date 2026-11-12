// Participant profiles of plan section 6.1. A profile decides whether a member checks in today;
// snipers and walkers time their check-ins instead, and griefers never check in.

export type ProfileName =
  | "loyal"
  | "lazy"
  | "leaving"
  | "fatigued"
  | "farmer"
  | "sniper-blocks"
  | "sniper-batch"
  | "griefer"
  | "walker";

export const PROFILE_LABELS: Record<ProfileName, string> = {
  loyal: "loyal (95%)",
  lazy: "lazy (50%)",
  leaving: "leaving (90%, −3 pt a day)",
  fatigued: "fatigued loyal (95% → 60%)",
  farmer: "farmer bot (100%)",
  "sniper-blocks": "sniper, separate blocks",
  "sniper-batch": "sniper, one atomic block",
  griefer: "griefer (never checks in, rejoins)",
  walker: "walker (once per inactive_days)",
};

export const isSniper = (profile: ProfileName) => profile === "sniper-blocks" || profile === "sniper-batch";

/**
 * The chance that a member of this profile checks in on `day` of a run of `days` days, or null when
 * the profile times its check-ins itself (snipers, walkers) or never checks in (griefers).
 */
export function checkInProbability(profile: ProfileName, day: number, days: number): number | null {
  switch (profile) {
    case "loyal":
      return 0.95;
    case "lazy":
      return 0.5;
    case "leaving":
      return Math.max(0, 0.9 - 0.03 * day);
    case "fatigued":
      return 0.95 - (0.35 * day) / Math.max(1, days - 1);
    case "farmer":
      return 1;
    default:
      return null;
  }
}
