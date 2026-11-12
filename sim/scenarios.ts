import { B, ContractError } from "./engine";
import { checkInProbability, isSniper, type ProfileName } from "./profiles";
import { Game, HOLDER, prng } from "./test-harness";

// The scenarios of plan section 6.1, played day by day on the simulator with the mainnet
// parameters. Within a day every check-in is its own transaction in its own block, in a random
// order; a kicker removes every kickable member at the start of each day; the harness checks the
// invariants after every call and runs pick_hero one block after each successful settle.

export interface ScenarioSpec {
  readonly name: string;
  readonly description: string;
  readonly players: ReadonlyArray<readonly [ProfileName, number]>;
}

const BASE: ScenarioSpec["players"] = [
  ["loyal", 60],
  ["lazy", 40],
  ["leaving", 10],
];

export const SCENARIOS: readonly ScenarioSpec[] = [
  { name: "base", description: "60 loyal, 40 lazy, 10 leaving", players: BASE },
  { name: "farmer", description: "base + 20 farmer bots checking in every day", players: [...BASE, ["farmer", 20]] },
  {
    name: "sniper-blocks",
    description: "base + 5 sniper accounts that check in once count ≥ goal − 5, one block each",
    players: [...BASE, ["sniper-blocks", 5]],
  },
  {
    name: "sniper-batch",
    description: "base + 5 sniper accounts that check in once count ≥ goal − 5, all in one block",
    players: [...BASE, ["sniper-batch", 5]],
  },
  {
    name: "griefer",
    description: "base + 70 griefers who never check in and rejoin the day after a kick",
    players: [...BASE, ["griefer", 70]],
  },
  {
    name: "walker",
    description: "base + 70 walkers who check in once per inactive_days to dodge the kick",
    players: [...BASE, ["walker", 70]],
  },
  {
    name: "fatigue",
    description: "base, but the loyal players fade from 95% to 60% over the run",
    players: [
      ["fatigued", 60],
      ["lazy", 40],
      ["leaving", 10],
    ],
  },
];

export interface DayRow {
  day: number;
  outcome: string;
  goal: number;
  count: number;
  streak: number;
  pot: bigint;
  total_supply: bigint;
  burned: bigint;
  per_share: bigint;
  hero_profile: string;
}

export interface ProfileRow {
  profile: ProfileName;
  accounts: number;
  checkIns: number;
  /** Final wealth minus initial funding, summed over the profile's accounts. */
  net: bigint;
  jackpots: number;
  kicked: number;
  /** Fees paid on being kicked (10% of the stake each time). */
  kickFees: bigint;
}

export interface SniperStats {
  /** Days that ended in success. */
  successDays: number;
  /** Closer seats (hero candidates) held by snipers on successful days, summed. */
  sniperCloserSeats: number;
  /** Closer seats of all successful days, summed (at most closers_k each). */
  totalCloserSeats: number;
  /** Jackpots the snipers won. */
  sniperJackpots: number;
}

/**
 * The snipers' strategy against the closers (R5, kept by the contract): wait until count reaches
 * goal − 5, then fire back to back, each in its own block (or, for `sniper-batch`, in one block).
 */
const SNIPER_WINDOW = 5;

export interface ScenarioResult {
  spec: ScenarioSpec;
  days: DayRow[];
  profiles: ProfileRow[];
  sniper: SniperStats | null;
  /** Contract refusals other than the ones a profile expects (should be 0). */
  unexpectedRefusals: string[];
  final: { streak: number; longest_streak: number; pot: bigint; total_supply: bigint; total_burned: bigint };
  initialPot: bigint;
  joinStake: bigint;
  emitBps: number;
  streakCap: number;
  streakStepBps: number;
}

interface Player {
  id: string;
  profile: ProfileName;
  funded: bigint;
  checkIns: number;
  kicked: number;
  kickFees: bigint;
  kickedOnDay: number | null;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other] as T, items[index] as T];
  }
  return items;
}

export function runScenario(spec: ScenarioSpec, options: { seed?: number; days?: number } = {}): ScenarioResult {
  const seed = options.seed ?? 42;
  const days = options.days ?? 60;
  const random = prng(seed);
  const game = new Game({ network: "mainnet", seed });
  const config = game.config;
  const initialPot = game.sim.state.pot;
  const unexpectedRefusals: string[] = [];

  const players: Player[] = spec.players.flatMap(([profile, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${profile}-${index}.test.near`,
      profile,
      funded: config.join_stake * 10n,
      checkIns: 0,
      kicked: 0,
      kickFees: 0n,
      kickedOnDay: null,
    }))
  );
  const byId = new Map(players.map((player) => [player.id, player]));
  const snipers = players.filter((player) => isSniper(player.profile));
  const batchSnipers = snipers.length > 0 && snipers[0]?.profile === "sniper-batch";

  /** A call whose refusal is a bug in the scenario, not part of the game. */
  const call = <T>(signer: string, action: Parameters<Game["call"]>[1], options: { sameBlock?: boolean } = {}) => {
    try {
      return game.call(signer, action, options) as T;
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      unexpectedRefusals.push(`${signer}: ${error.code}`);
      return undefined;
    }
  };

  const isMember = (id: string) => game.sim.state.members.has(id);
  const canCheckIn = (id: string, day: number) => {
    const member = game.sim.state.members.get(id);
    return member !== undefined && member.activation_day <= day && member.last_checkin !== day;
  };
  const checkIn = (player: Player, sameBlock = false) => {
    const result = call<{ in_closers: boolean }>(player.id, (sim, env) => sim.checkIn(env), { sameBlock });
    if (result) player.checkIns += 1;
    return result;
  };

  const sniperStats: SniperStats = {
    successDays: 0,
    sniperCloserSeats: 0,
    totalCloserSeats: 0,
    sniperJackpots: 0,
  };
  const snapshots = new Map<number, { total_supply: bigint; streak: number }>();
  const snapshot = (day: number) => {
    const s = game.sim.state;
    snapshots.set(day, { total_supply: s.total_supply, streak: s.streak });
  };
  const closersAtClose = new Map<number, string[]>();
  /** The open day's closers, read before the settle that closes it. */
  const openClosers = () => [...game.sim.state.open.closers];

  // Day 0: everyone is funded and joins; the first active day is warmup_days later.
  for (const player of players) {
    game.fund(player.id, player.funded);
    call(player.id, (sim, env) => sim.join(env));
  }

  for (let day = 0; day < days; day += 1) {
    if (day > 0) {
      game.goToDay(day, 0.01);
      closersAtClose.set(day - 1, openClosers());
      game.settle();
      snapshot(day - 1);

      // The kicker removes every member a kick applies to.
      for (const target of game.sim.getKickable(game.env(HOLDER), 0, players.length)) {
        const victim = byId.get(target);
        const stake = game.sim.getMember(game.env(HOLDER), target)?.effective_stake ?? 0n;
        if (call(HOLDER, (sim, env) => sim.kick(env, target)) !== undefined && victim) {
          victim.kicked += 1;
          victim.kickFees += (stake * BigInt(config.slash_bps)) / B;
          victim.kickedOnDay = day;
        }
      }
      // Griefers come back the day after a kick and start a new warmup.
      for (const player of players) {
        if (player.profile === "griefer" && !isMember(player.id) && (player.kickedOnDay ?? day) < day) {
          call(player.id, (sim, env) => sim.join(env));
        }
      }
    }

    const today = game.sim.state.open;
    const honest = shuffle(
      players.filter((player) => {
        if (!canCheckIn(player.id, day) || isSniper(player.profile)) return false;
        if (player.profile === "walker") {
          // Check in on the last day before the kick would apply.
          const kickableFrom = game.sim.getMember(game.env(HOLDER), player.id)?.kickable_from_day ?? 0;
          return day === kickableFrom - 1;
        }
        const probability = checkInProbability(player.profile, day, days);
        return probability !== null && random() < probability;
      }),
      random
    );

    let snipersFired = snipers.length === 0;
    const fireSnipers = () => {
      snipersFired = true;
      snipers
        .filter((player) => canCheckIn(player.id, day))
        .forEach((player, index) => {
          // Separate blocks: each in its own block, back to back. Batch: one block for all.
          checkIn(player, batchSnipers && index > 0);
        });
    };

    for (const player of honest) {
      if (!snipersFired && today.goal > 0 && game.sim.state.open.count >= today.goal - SNIPER_WINDOW) fireSnipers();
      checkIn(player);
    }
    if (!snipersFired) fireSnipers();
  }

  game.goToDay(days, 0.01);
  closersAtClose.set(days - 1, openClosers());
  game.settle();
  snapshot(days - 1);

  const history = game.sim
    .getHistory(days)
    .slice()
    .reverse()
    .filter((summary) => summary.day < days);
  const sniperIds = new Set(snipers.map((player) => player.id));
  const jackpotsByPlayer = new Map<string, number>();
  for (const summary of history) {
    if (summary.hero) jackpotsByPlayer.set(summary.hero, (jackpotsByPlayer.get(summary.hero) ?? 0) + 1);
    if (summary.outcome === "Success") {
      sniperStats.successDays += 1;
      const closers = closersAtClose.get(summary.day) ?? [];
      sniperStats.totalCloserSeats += closers.length;
      sniperStats.sniperCloserSeats += closers.filter((id) => sniperIds.has(id)).length;
      if (summary.hero && sniperIds.has(summary.hero)) sniperStats.sniperJackpots += 1;
    }
  }

  const env = game.env(HOLDER);
  const wealth = (player: Player) => {
    const member = game.sim.getMember(env, player.id);
    return game.sim.ftBalanceOf(player.id) + (member ? member.effective_stake + member.pending_claimable : 0n);
  };
  const profiles: ProfileRow[] = spec.players.map(([profile]) => {
    const group = players.filter((player) => player.profile === profile);
    return {
      profile,
      accounts: group.length,
      checkIns: group.reduce((sum, player) => sum + player.checkIns, 0),
      net: group.reduce((sum, player) => sum + wealth(player) - player.funded, 0n),
      jackpots: group.reduce((sum, player) => sum + (jackpotsByPlayer.get(player.id) ?? 0), 0),
      kicked: group.reduce((sum, player) => sum + player.kicked, 0),
      kickFees: group.reduce((sum, player) => sum + player.kickFees, 0n),
    };
  });

  const profileOf = (id: string | null) => (id ? (byId.get(id)?.profile ?? "?") : "");
  const dayRows: DayRow[] = history.map((summary) => ({
    day: summary.day,
    outcome: summary.outcome,
    goal: summary.goal,
    count: summary.count,
    streak: summary.streak_after,
    pot: summary.pot_after,
    total_supply: snapshots.get(summary.day)?.total_supply ?? 0n,
    burned: summary.pot_burned + summary.stake_slashed,
    per_share: summary.per_share,
    hero_profile: profileOf(summary.hero),
  }));

  const s = game.sim.state;
  return {
    spec,
    days: dayRows,
    profiles,
    sniper: snipers.length > 0 ? sniperStats : null,
    unexpectedRefusals,
    final: {
      streak: s.streak,
      longest_streak: s.longest_streak,
      pot: s.pot,
      total_supply: s.total_supply,
      total_burned: s.total_burned,
    },
    initialPot,
    joinStake: config.join_stake,
    emitBps: config.emit_bps,
    streakCap: config.streak_cap,
    streakStepBps: config.streak_step_bps,
  };
}

/** Days until the pot halves from emission alone at a given streak (no failures). */
export function potHalfLifeDays(emitBps: number, streak: number, streakCap: number, stepBps: number): number {
  const multBps = 10_000 + Math.min(streak, streakCap) * stepBps;
  const dailyShare = (emitBps * multBps) / 1e8;
  return Math.log(0.5) / Math.log(1 - dailyShare);
}
