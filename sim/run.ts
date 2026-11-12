// bun run sim [--seed N] [--days N] [--out DIR]
// Plays every scenario of plan section 6.1 and writes out/sim-<scenario>.csv and out/sim-report.md.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PROFILE_LABELS } from "./profiles";
import { potHalfLifeDays, runScenario, SCENARIOS, type ScenarioResult } from "./scenarios";

const DECIMALS = 18n;

/** Token amount in LAST with two decimals, from yocto-LAST. */
export function formatLast(amount: bigint): string {
  const negative = amount < 0n;
  const cents = ((negative ? -amount : amount) + 5n * 10n ** (DECIMALS - 3n)) / 10n ** (DECIMALS - 2n);
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${negative ? "−" : ""}${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

const percent = (part: number, whole: number) => (whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`);

export function scenarioCsv(result: ScenarioResult): string {
  const header = "day,outcome,goal,count,streak,pot,total_supply,burned,per_share,hero_profile";
  const rows = result.days.map((row) =>
    [
      row.day,
      row.outcome,
      row.goal,
      row.count,
      row.streak,
      row.pot,
      row.total_supply,
      row.burned,
      row.per_share,
      row.hero_profile,
    ].join(",")
  );
  return `${[header, ...rows].join("\n")}\n`;
}

function scenarioSection(result: ScenarioResult, base: ScenarioResult | undefined): string {
  const outcomes = { Success: 0, Fail: 0, Idle: 0 } as Record<string, number>;
  for (const row of result.days) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  const days = result.days.length;
  const lines = [
    `## ${result.spec.name}`,
    "",
    `${result.spec.description}.`,
    "",
    `- Days: ${days}. Success ${outcomes.Success}, fail ${outcomes.Fail}, idle ${outcomes.Idle}.`,
    `- Streak at the end ${result.final.streak}, record ${result.final.longest_streak}.`,
    `- Pot: ${formatLast(result.initialPot)} → ${formatLast(result.final.pot)} LAST. Burned in total: ${formatLast(result.final.total_burned)} LAST.`,
    "",
    "| Profile | Accounts | Check-ins per account per day | Net per account, LAST | ROI on stake | Jackpots | Kicked |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of result.profiles) {
    const perAccount = row.accounts === 0 ? 0n : row.net / BigInt(row.accounts);
    const roiBasisPoints = (perAccount * 10_000n) / result.joinStake;
    lines.push(
      `| ${PROFILE_LABELS[row.profile]} | ${row.accounts} | ${(row.checkIns / Math.max(1, row.accounts * days)).toFixed(2)} | ${formatLast(perAccount)} | ${(Number(roiBasisPoints) / 100).toFixed(2)}% | ${row.jackpots} | ${row.kicked} |`
    );
  }

  if (result.sniper) {
    const s = result.sniper;
    const sniperAccounts = result.profiles.find((row) => row.profile.startsWith("sniper"))?.accounts ?? 0;
    const allAccounts = result.profiles.reduce((sum, row) => sum + row.accounts, 0);
    lines.push(
      "",
      `Snipers held ${s.sniperCloserSeats} of ${s.totalCloserSeats} closer seats on ${s.successDays} successful days (${percent(s.sniperCloserSeats, s.totalCloserSeats)}) and won ${s.sniperJackpots} of ${s.successDays} jackpots (${percent(s.sniperJackpots, s.successDays)}). They are ${percent(sniperAccounts, allAccounts)} of the accounts.`
    );
  }

  const griefers = result.profiles.find((row) => row.profile === "griefer" || row.profile === "walker");
  if (griefers && base) {
    const extraBurn = result.final.total_burned - base.final.total_burned;
    lines.push(
      "",
      `${PROFILE_LABELS[griefers.profile]}: ${griefers.kicked} kicks cost them ${formatLast(griefers.kickFees)} LAST in kick fees; their net result is ${formatLast(griefers.net)} LAST. Compared with the base scenario, ${formatLast(extraBurn)} LAST more was burned, and the pot ends ${formatLast(base.final.pot - result.final.pot)} LAST lower.`
    );
  }
  return lines.join("\n");
}

export function report(results: ScenarioResult[], seed: number): string {
  const base = results.find((result) => result.spec.name === "base");
  const first = results[0];
  const runway = first
    ? [
        "## How long the pot lasts",
        "",
        "Days until the pot halves from rewards alone (no failed days), with the mainnet parameters:",
        "",
        `- streak 0: ${Math.round(potHalfLifeDays(first.emitBps, 0, first.streakCap, first.streakStepBps))} days;`,
        `- streak ${first.streakCap} (the cap): ${Math.round(potHalfLifeDays(first.emitBps, first.streakCap, first.streakCap, first.streakStepBps))} days;`,
        ...results.map(
          (result) =>
            `- ${result.spec.name}, at its final streak ${result.final.streak}: ${Math.round(potHalfLifeDays(result.emitBps, result.final.streak, result.streakCap, result.streakStepBps))} days.`
        ),
        "",
        "Each failed day also burns 5% of the pot.",
      ]
    : [];
  return [
    "# Last Call simulation",
    "",
    `Seed ${seed}, mainnet parameters (config/params.json). Generated by \`bun run sim\`. Every account starts with ten stakes; "net" is the final balance plus stake and unclaimed rewards minus that funding. Days 0 and 1 are warmup.`,
    "",
    ...results.flatMap((result) => [scenarioSection(result, base), ""]),
    ...runway,
    "",
  ].join("\n");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const seed = Number(argument("--seed") ?? 42);
  const days = Number(argument("--days") ?? 60);
  const outDir = path.resolve(argument("--out") ?? "out");
  await mkdir(outDir, { recursive: true });

  const results: ScenarioResult[] = [];
  for (const spec of SCENARIOS) {
    const started = performance.now();
    const result = runScenario(spec, { seed, days });
    results.push(result);
    await writeFile(path.join(outDir, `sim-${spec.name}.csv`), scenarioCsv(result));
    const success = result.days.filter((row) => row.outcome === "Success").length;
    console.info(
      `${spec.name.padEnd(14)} success ${String(success).padStart(2)}/${days}  streak ${result.final.streak}  pot ${formatLast(result.final.pot)}  refusals ${result.unexpectedRefusals.length}  ${Math.round(performance.now() - started)} ms`
    );
  }
  await writeFile(path.join(outDir, "sim-report.md"), report(results, seed));
  console.info(`Wrote ${path.join(outDir, "sim-report.md")}`);
}
