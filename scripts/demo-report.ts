import type { DaySummary } from "../web/src/contract/views";
import { formatLast } from "../web/src/game/format";

// Plain-text lines for `bun run demo`. Pure, so the wording is tested without a sandbox.

/** `bot-3.sandbox` → `bot-3`. */
export function shortName(accountId: string): string {
  return accountId.split(".")[0] ?? accountId;
}

/** One settled day: outcome, check-ins against the goal, rewards or burns, closers, and the hero. */
export function formatDay(day: DaySummary, closers: readonly string[]): string {
  const head = `Day ${day.day}: ${day.count} of ${day.goal} checked in`;
  const candidates = closers.length > 0 ? `closers ${closers.map(shortName).join(", ")}` : "no closers";
  switch (day.outcome) {
    case "Success": {
      const hero = day.hero ? `hero ${shortName(day.hero)} +${formatLast(day.jackpot)}` : "no jackpot";
      return `${head} — SUCCESS, streak ${day.streakAfter}. Each +${formatLast(day.perShare)}; ${candidates}; ${hero}.`;
    }
    case "Fail":
      return `${head} — FAIL, streak reset. Burnt ${formatLast(day.potBurned)} from the pot and ${formatLast(day.stakeSlashed)} from absent stakes.`;
    case "Idle":
      return `${head} — idle (fewer than min_goal active members), nothing changes.`;
  }
}

export interface FinalRow {
  readonly name: string;
  readonly balance: bigint;
  readonly stake: bigint;
  readonly claimable: bigint;
  readonly checkins: number;
  readonly heroCount: number;
}

/** A fixed-width table of every player at the end. */
export function formatTable(rows: readonly FinalRow[]): string {
  const header = ["player", "wallet", "stake", "to claim", "check-ins", "hero"];
  const lines = rows.map((row) => [
    row.name,
    formatLast(row.balance),
    formatLast(row.stake),
    formatLast(row.claimable),
    String(row.checkins),
    String(row.heroCount),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...lines.map((line) => line[column]?.length ?? 0))
  );
  const render = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)))
      .join("  ");
  return [render(header), ...lines.map(render)].join("\n");
}
