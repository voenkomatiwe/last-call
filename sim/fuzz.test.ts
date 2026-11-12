import { expect, test } from "bun:test";

import { ContractError } from "./engine";
import { Game, HOLDER, prng } from "./test-harness";

// Section 5 item 9b: random sequences of join / check_in / leave / kick / claim / settle, lost
// pick_hero promises, and "everyone leaves" / "everyone returns" days. The harness checks the
// invariants after every call; I9 (game calls leave last_settled == today - 1) is checked here.
// Any error other than a contract refusal (an arithmetic overflow or a broken invariant) fails.

const RUNS = Number(process.env.SIM_FUZZ_RUNS ?? 200);
const DAYS = 120;
const PLAYERS = 20;

/**
 * Four kinds of runs. Round stakes (10^21, 10^23) divide exactly for the first 20-odd slashes, so
 * rounding dust only appears in long losing streaks; uneven stakes make it appear from the first
 * slash, and disabling kick lets it pile up. Without them the fuzz misses rounding defects.
 */
function fuzzConfig(run: number) {
  const uneven = 10n ** 21n + BigInt(run) * 7919n + 1n;
  switch (run % 4) {
    case 0:
      return {};
    case 1:
      return { join_stake: 10n ** 23n };
    case 2:
      return { join_stake: uneven };
    default:
      return { join_stake: uneven, inactive_days: 10_000 };
  }
}

function fuzzRun(run: number): { calls: number; refusals: number } {
  const random = prng(run + 1);
  const chance = (p: number) => random() < p;
  const game = new Game({ seed: run + 1, config: fuzzConfig(run) });
  const players = Array.from({ length: PLAYERS }, (_, index) => `p${index}.test.near`);
  for (const player of players) game.fund(player, game.config.join_stake * 20n);

  let calls = 0;
  let refusals = 0;
  const attempt = (signer: string, action: Parameters<Game["call"]>[1], gameCall = true) => {
    calls += 1;
    try {
      game.call(signer, action);
      if (gameCall) {
        const s = game.sim.state;
        expect(s.last_settled).toBe(game.today - 1);
      }
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      refusals += 1;
    }
  };

  for (let day = 1; day <= DAYS; day += 1) {
    game.goToDay(day, random() * 0.5);
    game.autoPickHero = !chance(0.1); // sometimes the pick_hero promise is lost
    if (!game.autoPickHero) game.sim.takeScheduled();

    const exodus = chance(0.03);
    const comeback = chance(0.05);
    // Each player has a temperament that drifts with the run: loyal, lazy, or leaving.
    for (const [index, player] of players.entries()) {
      const isMember = game.sim.state.members.has(player);
      const loyalty = index < 8 ? 0.95 : index < 15 ? 0.5 : 0.2;
      if (exodus && isMember) attempt(player, (sim, env) => sim.leave(env));
      else if (!isMember) {
        if (comeback || chance(0.15)) attempt(player, (sim, env) => sim.join(env));
      } else if (chance(loyalty)) {
        attempt(player, (sim, env) => sim.checkIn(env));
        // Leaving on the day of one's own check-in forfeits that day's share (plan R4).
        if (chance(0.03)) attempt(player, (sim, env) => sim.leave(env));
      } else if (chance(0.03)) attempt(player, (sim, env) => sim.leave(env));
      if (isMember && chance(0.05)) attempt(player, (sim, env) => sim.claim(env));
    }

    if (chance(0.5)) {
      const kickable = game.sim.getKickable(game.env(HOLDER), 0, PLAYERS);
      for (const target of kickable) attempt(HOLDER, (sim, env) => sim.kick(env, target));
    }
    if (chance(0.2)) attempt(HOLDER, (sim, env) => sim.settle(env), false);
    if (!game.autoPickHero) game.sim.takeScheduled();
  }

  // Everyone leaves at the end: the pool must empty without a panic.
  game.goToDay(DAYS + 1);
  game.autoPickHero = true;
  for (const player of players) {
    if (game.sim.state.members.has(player)) attempt(player, (sim, env) => sim.leave(env));
  }
  expect(game.sim.state).toMatchObject({ stake_pool: 0n, active_stake: 0n, members_total: 0, reserved: 0n });
  return { calls, refusals };
}

test(`fuzz: ${RUNS} runs of ${DAYS} days keep every invariant`, () => {
  let calls = 0;
  let refusals = 0;
  for (let run = 0; run < RUNS; run += 1) {
    try {
      const result = fuzzRun(run);
      calls += result.calls;
      refusals += result.refusals;
    } catch (error) {
      throw new Error(`fuzz run ${run} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The runs must exercise the game, not just collect refusals.
  expect(calls).toBeGreaterThan(RUNS * DAYS * 5);
  expect(refusals).toBeLessThan(calls / 2);
}, 600_000);
