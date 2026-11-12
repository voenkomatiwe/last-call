import { describe, expect, test } from "bun:test";

import { AUTO_SETTLE_CAP, B, ContractError, heroIndex } from "./engine";
import { CONTRACT, errorCode, Game, HOLDER } from "./test-harness";

// Expected numbers are computed here from the formulas of plan section 4.4, independently of the
// engine's code path. Section 5 item numbers are in the test names.

const E8 = 100_000_000n;
const slashOnce = (stake: bigint, slashBps = 1000n) => (stake * (B - slashBps)) / B;

/** A game with `members` active members on day 1 (demo set: warmup 1). */
function activeGame(members: number, options: ConstructorParameters<typeof Game>[0] = {}) {
  const game = new Game(options);
  const accounts = game.joinMany(members);
  game.goToDay(game.config.warmup_days);
  // Days open lazily, on the first touch: settle opens the activation day.
  game.settle();
  return { game, accounts };
}

describe("new (item 1)", () => {
  test("mints the supply once and splits it into pot, faucet, and the holder's share", () => {
    const game = new Game();
    const s = game.sim.state;
    expect(s.total_supply).toBe(10n ** 27n);
    expect(s.pot).toBe(5n * 10n ** 26n);
    expect(s.faucet_left).toBe(10n ** 25n);
    expect(game.sim.ftBalanceOf(HOLDER)).toBe(10n ** 27n - 5n * 10n ** 26n - 10n ** 25n);
    expect(game.sim.ftBalanceOf(CONTRACT)).toBe(s.pot + s.faucet_left);
    expect(s.open).toMatchObject({ day: 0, goal: 0 });
    expect(s.last_settled).toBeNull();
  });
});

describe("warmup and double check-in (items 3, 4)", () => {
  test("a member cannot check in before the activation day", () => {
    const game = new Game({ config: { warmup_days: 2 } });
    const [alice] = game.joinMany(1) as [string];
    expect(errorCode(() => game.checkIn(alice))).toBe("ERR_WARMUP");
    game.goToDay(1);
    expect(errorCode(() => game.checkIn(alice))).toBe("ERR_WARMUP");
    game.goToDay(2);
    expect(game.checkIn(alice)).toMatchObject({ day: 2, n: 1 });
  });

  test("one check-in per day", () => {
    const { game, accounts } = activeGame(1);
    const [alice] = accounts as [string];
    game.checkIn(alice);
    expect(errorCode(() => game.checkIn(alice))).toBe("ERR_ALREADY_CHECKED_IN");
    game.goToDay(2);
    expect(game.checkIn(alice).day).toBe(2);
  });

  test("a stranger cannot check in", () => {
    const game = new Game();
    expect(errorCode(() => game.checkIn("stranger.test.near"))).toBe("ERR_NOT_MEMBER");
  });
});

describe("day outcomes (items 5–9)", () => {
  test("idle day: fewer active members than min_goal changes nothing", () => {
    const { game, accounts } = activeGame(2);
    const before = { pot: game.sim.state.pot, supply: game.sim.state.total_supply };
    expect(game.sim.state.open.goal).toBe(0);
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();

    const [day1] = game.sim.getHistory(1);
    expect(day1).toMatchObject({ day: 1, outcome: "Idle", goal: 0, count: 2, per_share: 0n });
    expect(game.sim.state).toMatchObject({ streak: 0, pot: before.pot, total_supply: before.supply });
  });

  test("goal is max(min_goal, ceil(active × goal_bps / B))", () => {
    const { game } = activeGame(7);
    // ceil(7 × 0.6) = ceil(4.2) = 5
    expect(game.sim.state.open).toMatchObject({ goal: 5, active: 7 });
  });

  test("success: shares, reserve, streak, and the jackpot leave the pot by the formula", () => {
    const { game, accounts } = activeGame(5);
    const potBefore = game.sim.state.pot;
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();

    const mult = B + 1n * 1000n; // streak 1, step 1000
    const budget = (potBefore * 100n * mult) / E8;
    const perShare = budget / BigInt(5 + 10);
    const [day1] = game.sim.getHistory(1);
    expect(day1).toMatchObject({ outcome: "Success", count: 5, goal: 3, streak_after: 1, per_share: perShare });
    expect(day1?.jackpot).toBe(perShare * 10n);
    expect(game.sim.state.reserved).toBe(perShare * 5n);
    expect(game.sim.state.pot).toBe(potBefore - perShare * 15n);
    expect(game.sim.state.longest_streak).toBe(1);
  });

  test("the streak multiplier stops growing at streak_cap", () => {
    const { game, accounts } = activeGame(3);
    const perShares: bigint[] = [];
    for (let day = 1; day <= 13; day += 1) {
      for (const account of accounts) game.checkIn(account);
      const potBefore = game.sim.state.pot;
      game.goToDay(day + 1);
      game.settle();
      const summary = game.sim.getHistory(1)[0];
      const mult = B + BigInt(Math.min(day, 10)) * 1000n;
      expect(summary?.per_share).toBe((potBefore * 100n * mult) / E8 / 13n);
      perShares.push(summary?.per_share ?? 0n);
    }
    expect(game.sim.state.streak).toBe(13);
  });

  test("failure: 5% of the pot burns, 10% of unchecked stake is slashed, streak resets", () => {
    const { game, accounts } = activeGame(5);
    const [alice] = accounts as [string];
    game.checkIn(alice); // goal 3, only one check-in
    const s = game.sim.state;
    const potBefore = s.pot;
    const supplyBefore = s.total_supply;
    const stake = game.config.join_stake;
    game.goToDay(2);
    game.settle();

    const potBurn = (potBefore * 500n) / B;
    const slash = (4n * stake * 1000n) / B;
    expect(game.sim.getHistory(1)[0]).toMatchObject({ outcome: "Fail", pot_burned: potBurn, stake_slashed: slash });
    expect(s.pot).toBe(potBefore - potBurn);
    expect(s.total_supply).toBe(supplyBefore - potBurn - slash);
    expect(s.stake_pool).toBe(5n * stake - slash);
    expect(s.streak).toBe(0);

    // Item 8: the member who checked in is not slashed; the others are, lazily.
    const env = game.env(HOLDER);
    expect(game.sim.getMember(env, alice)?.effective_stake).toBe(stake);
    expect(game.sim.getMember(env, accounts[1] as string)?.effective_stake).toBe(slashOnce(stake));
  });

  test("a share earned on a success day is collected ten days later (item 8)", () => {
    const { game, accounts } = activeGame(3);
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();
    const perShare = game.sim.getHistory(1)[0]?.per_share ?? 0n;
    const balance = game.sim.ftBalanceOf(accounts[0] as string);

    game.goToDay(12);
    game.settle();
    expect(game.call(accounts[0] as string, (sim, env) => sim.claim(env))).toBe(perShare);
    expect(game.sim.ftBalanceOf(accounts[0] as string)).toBe(balance + perShare);
  });

  test("three untouched days fail three times (item 9), across the 64-day word boundary", () => {
    const { game } = activeGame(5);
    // Days 1..62 succeed is not needed: untouched active days fail. Settle up to day 66.
    const stake = game.config.join_stake;
    game.goToDay(60);
    game.settle();
    const potBefore = game.sim.state.pot;
    game.goToDay(63);
    game.settle();
    const expectedPot = [0, 1, 2].reduce((pot) => pot - (pot * 500n) / B, potBefore);
    expect(game.sim.state.pot).toBe(expectedPot);
    game.goToDay(66);
    game.settle();
    for (const day of [62, 63, 64, 65]) expect(game.sim.state.failed_days.has(day)).toBe(true);
    const env = game.env(HOLDER);
    const expectedStake = Array.from({ length: 65 }).reduce<bigint>((value) => slashOnce(value), stake);
    expect(game.sim.getMember(env, "player-0.test.near")?.effective_stake).toBe(expectedStake);
  });
});

/** A seed whose draw over `count` candidates on `day` lands on index `index`. */
function seedFor(day: number, count: number, index: number): Uint8Array {
  for (let value = 0; value < 256; value += 1) {
    const seed = new Uint8Array(32).fill(value);
    if (heroIndex(seed, day, count) === index) return seed;
  }
  throw new Error("no seed found");
}

// Mirrors `contract/src/checkin.rs` tests t11–t12 (R5).
describe("closers (items 11–12, R5)", () => {
  test("two check-ins in one block: only the first is a candidate (t11)", () => {
    const { game, accounts } = activeGame(10); // goal 6, K 5
    const [a, b, c] = accounts as [string, string, string];
    const results = [game.checkIn(a), game.checkIn(b, { sameBlock: true }), game.checkIn(c)];
    expect(game.sim.state.open.goal).toBe(6);
    expect(results.map((result) => result.in_closers)).toEqual([true, false, true]);
    expect(results.map((result) => result.n)).toEqual([1, 2, 3]);
    expect(game.sim.state.open.closers).toEqual([a, c]);
  });

  test("five in one block give one candidate (t11)", () => {
    const { game, accounts } = activeGame(10);
    const batch = accounts.slice(0, 5).map((account, index) => game.checkIn(account, { sameBlock: index > 0 }));
    expect(batch.map((result) => result.in_closers)).toEqual([true, false, false, false, false]);
    expect(game.checkIn(accounts[5] as string).in_closers).toBe(true);
    expect(game.sim.state.open.closers).toEqual([accounts[0] as string, accounts[5] as string]);
  });

  test("the window slides until the goal, then freezes (t12)", () => {
    const { game, accounts } = activeGame(10);
    const results = accounts.map((account) => game.checkIn(account));
    expect(results.map((result) => result.in_closers)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(game.sim.state.open.closers).toEqual(accounts.slice(1, 6));
    expect(game.sim.getOpenDay(game.env(HOLDER)).closers).toEqual(accounts.slice(1, 6));
  });

  test("a goal below K: the window never fills (t12)", () => {
    const { game, accounts } = activeGame(4); // goal 3
    const results = accounts.map((account) => game.checkIn(account));
    expect(game.sim.state.open.goal).toBe(3);
    expect(results.map((result) => result.in_closers)).toEqual([true, true, true, false]);
    expect(game.sim.state.open.closers).toEqual(accounts.slice(0, 3));
  });

  test("an idle day has no candidates", () => {
    const { game, accounts } = activeGame(2); // fewer than min_goal
    expect(game.checkIn(accounts[0] as string).in_closers).toBe(false);
    expect(game.sim.state.open.closers).toEqual([]);
  });

  test("a success schedules pick_hero; a failure and an idle day do not", () => {
    const { game, accounts } = activeGame(3, { autoPickHero: false });
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();
    expect(game.sim.state.pending_heroes.map((entry) => entry.day)).toEqual([1]);
    expect(game.sim.takeScheduled()).toEqual([{ method: "pick_hero", day: 1 }]);

    game.goToDay(3);
    game.settle(); // day 2: nobody checked in, so it failed
    expect(game.sim.takeScheduled()).toEqual([]);
  });
});

describe("pick_hero (items 14, 15, R10)", () => {
  function successfulDay(options: { autoPickHero?: boolean } = {}) {
    const { game, accounts } = activeGame(5, { autoPickHero: options.autoPickHero ?? false }); // goal 3
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();
    return { game, accounts };
  }

  test("the hero is drawn from the closers by the specified hash and receives the jackpot", () => {
    const { game, accounts } = successfulDay();
    const pending = game.sim.state.pending_heroes[0];
    if (!pending) throw new Error("no pending hero");
    expect(pending.closers).toEqual(accounts.slice(0, 3));
    const seed = new Uint8Array(32).fill(7);
    const hero = pending.closers[heroIndex(seed, 1, pending.closers.length)] as string;
    const before = game.sim.ftBalanceOf(hero);

    game.runPickHero(seed);
    expect(game.sim.ftBalanceOf(hero)).toBe(before + pending.jackpot);
    expect(game.sim.getHistory(1)[0]?.hero).toBe(hero);
    expect(game.sim.state.jackpot_pending).toBe(0n);
    expect(game.sim.state.total_jackpots).toBe(pending.jackpot);
    expect(game.sim.state.members.get(hero)?.hero_count).toBe(1);
  });

  test("the draw is roughly uniform over five candidates", () => {
    const counts = [0, 0, 0, 0, 0];
    for (let index = 0; index < 1000; index += 1) {
      const seed = new Uint8Array(32);
      new DataView(seed.buffer).setUint32(0, index, true);
      const slot = heroIndex(seed, 1, 5);
      counts[slot] = (counts[slot] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(150);
  });

  test("only the contract may call it; a repeat or another day does nothing", () => {
    const { game } = successfulDay();
    expect(errorCode(() => game.sim.pickHero(game.env(HOLDER, new Uint8Array(32)), 1))).toBe("ERR_PRIVATE");
    game.sim.pickHero(game.env(CONTRACT, new Uint8Array(32)), 2);
    expect(game.sim.state.pending_heroes.map((entry) => entry.day)).toEqual([1]);
    game.runPickHero();
    const after = structuredClone(game.sim.state);
    game.sim.pickHero(game.env(CONTRACT, new Uint8Array(32)), 1);
    expect(game.sim.state).toEqual(after);
  });

  test("a hero who left and unregistered: the jackpot returns to the pot", () => {
    const { game } = successfulDay();
    const pending = game.sim.state.pending_heroes[0];
    if (!pending) throw new Error("no pending hero");
    const seed = new Uint8Array(32).fill(3);
    const hero = pending.closers[heroIndex(seed, 1, pending.closers.length)] as string;

    game.goToDay(2, 0.9);
    game.call(hero, (sim, env) => sim.leave(env));
    const balance = game.sim.ftBalanceOf(hero);
    game.call(hero, (sim, env) => sim.ftTransfer(env, HOLDER, balance));
    game.call(hero, (sim, env) => sim.storageUnregister(env));
    const pot = game.sim.state.pot;

    game.runPickHero(seed);
    expect(game.sim.state.pot).toBe(pot + pending.jackpot);
    expect(game.sim.state.total_jackpots).toBe(0n);
    // The draw happened: the history names the hero even though the jackpot went back.
    expect(game.sim.getHistory(2).find((summary) => summary.day === 1)?.hero).toBe(hero);
  });

  test("a lost draw stays pending next to a newer one; retry_pick_hero reschedules it", () => {
    const { game, accounts } = successfulDay();
    game.sim.takeScheduled(); // the day-1 promise ran out of gas
    for (const account of accounts) game.checkIn(account);
    game.goToDay(3);
    game.settle();
    game.sim.takeScheduled(); // and the day-2 one too
    const [first, second] = game.sim.state.pending_heroes;
    expect([first?.day, second?.day]).toEqual([1, 2]);
    expect(game.sim.state.jackpot_pending).toBe((first?.jackpot ?? 0n) + (second?.jackpot ?? 0n));

    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.retryPickHero(env, 5)))).toBe("ERR_NO_PENDING_HERO");
    game.call(HOLDER, (sim, env) => sim.retryPickHero(env, 1));
    game.runPickHero(seedFor(1, 3, 0));
    expect(game.sim.state.pending_heroes.map((entry) => entry.day)).toEqual([2]);
    expect(game.sim.getHistory(3).find((summary) => summary.day === 1)?.hero).toBe(accounts[0]);
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.retryPickHero(env, 1)))).toBe("ERR_NO_PENDING_HERO");
  });
});

describe("outcome edges (R11)", () => {
  test("everyone active left during a day with a goal: the day is idle, not a failure", () => {
    const { game, accounts } = activeGame(3); // goal 3
    for (const account of accounts) game.call(account, (sim, env) => sim.leave(env));
    const streak = game.sim.state.streak;
    game.goToDay(2);
    game.settle();
    expect(game.sim.getHistory(1)[0]).toMatchObject({ day: 1, outcome: "Idle", goal: 3, pot_burned: 0n });
    expect(game.sim.state.streak).toBe(streak);
  });
});

describe("money and edges (items 16–19)", () => {
  test("an empty pot: success pays nothing and creates no record", () => {
    const { game, accounts } = activeGame(3, { args: { pot_bps: 0 } });
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();
    expect(game.sim.getHistory(1)[0]).toMatchObject({ outcome: "Success", per_share: 0n, jackpot: 0n });
    expect(game.sim.state.rewards.size).toBe(0);
    expect(game.sim.state.pending_heroes).toEqual([]);
  });

  test("claim without anything to claim, twice", () => {
    const { game, accounts } = activeGame(1);
    const alice = accounts[0] as string;
    expect(errorCode(() => game.call(alice, (sim, env) => sim.claim(env)))).toBe("ERR_NOTHING_TO_CLAIM");
    expect(errorCode(() => game.call(alice, (sim, env) => sim.claim(env)))).toBe("ERR_NOTHING_TO_CLAIM");
  });

  test("leave during warmup returns the full stake and undoes maturing", () => {
    const game = new Game();
    const [alice] = game.joinMany(1) as [string];
    const balance = game.sim.ftBalanceOf(alice);
    expect(game.call(alice, (sim, env) => sim.leave(env))).toBe(game.config.join_stake);
    expect(game.sim.ftBalanceOf(alice)).toBe(balance + game.config.join_stake);
    expect(game.sim.state.maturing.size).toBe(0);
  });

  test("leave after checking in today: no fee, its share is forfeited (I10)", () => {
    const { game, accounts } = activeGame(4); // goal 3
    for (const account of accounts) game.checkIn(account);
    const leaver = accounts[0] as string;
    expect(game.call(leaver, (sim, env) => sim.leave(env))).toBe(game.config.join_stake);
    expect(game.sim.state.open).toMatchObject({ forfeited: 1, count: 4 });

    game.goToDay(2);
    game.settle();
    const perShare = game.sim.getHistory(1)[0]?.per_share ?? 0n;
    expect(game.sim.state.rewards.get(1)?.refs).toBe(3);
    expect(game.sim.state.reserved).toBe(perShare * 3n);
  });

  test("leave without checking in today burns the fee", () => {
    const { game, accounts } = activeGame(3);
    const stake = game.config.join_stake;
    const supply = game.sim.state.total_supply;
    expect(game.call(accounts[0] as string, (sim, env) => sim.leave(env))).toBe(stake - stake / 10n);
    expect(game.sim.state.total_supply).toBe(supply - stake / 10n);
  });

  test("leave and join again start a new warmup", () => {
    const { game, accounts } = activeGame(1);
    const alice = accounts[0] as string;
    game.call(alice, (sim, env) => sim.leave(env));
    game.call(alice, (sim, env) => sim.join(env));
    expect(errorCode(() => game.checkIn(alice))).toBe("ERR_WARMUP");
  });

  test("everyone leaves on a failing day with dust: no panic, dust goes to the pot (items 9b, 18)", () => {
    const { game, accounts } = activeGame(4, { config: { join_stake: 10n ** 23n } });
    const loyal = accounts[0] as string;
    // 30 failed days for three members; the loyal one checks in alone (goal 3 is never met).
    for (let day = 1; day <= 30; day += 1) {
      game.goToDay(day);
      game.checkIn(loyal);
    }
    game.goToDay(31);
    game.checkIn(loyal);
    for (const account of accounts) game.call(account, (sim, env) => sim.leave(env));
    expect(game.sim.state).toMatchObject({ stake_pool: 0n, active_stake: 0n, members_total: 0 });
    expect(game.sim.state.open.active_stake).toBe(0n);
    game.goToDay(33);
    expect(() => game.settle()).not.toThrow();
  });
});

describe("kick and backlog (items 24, 27)", () => {
  test("kick before inactive_days is refused", () => {
    const { game, accounts } = activeGame(3); // inactive_days 3, active from day 1
    game.goToDay(3);
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.kick(env, accounts[0] as string)))).toBe(
      "ERR_NOT_INACTIVE"
    );
    game.goToDay(4); // since = activation day 1, kickable from day 1 + 3
    expect(game.call(HOLDER, (sim, env) => sim.kick(env, accounts[0] as string))).toBeGreaterThan(0n);
  });

  test("kick during warmup is refused", () => {
    const game = new Game({ config: { warmup_days: 5, inactive_days: 1 } });
    const [late] = game.joinMany(1, "late") as [string];
    game.goToDay(4);
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.kick(env, late)))).toBe("ERR_NOT_INACTIVE");
  });

  test("kick after inactive_days burns the fee and lowers the next goal", () => {
    const { game, accounts } = activeGame(6); // goal 4
    const [lazy, ...others] = accounts as [string, ...string[]];
    for (let day = 1; day <= 3; day += 1) {
      game.goToDay(day);
      for (const account of others) game.checkIn(account);
    }
    game.goToDay(4);
    expect(game.sim.getKickable(game.env(HOLDER), 0, 100)).toEqual([lazy]);
    const lazyStake = game.sim.getMember(game.env(HOLDER), lazy)?.effective_stake ?? 0n;
    const lazyBalance = game.sim.ftBalanceOf(lazy);
    const holderBalance = game.sim.ftBalanceOf(HOLDER);
    const supply = game.sim.state.total_supply;
    const fee = (lazyStake * 1000n) / B;
    const bounty = (fee * 2000n) / B; // kick_bounty_bps 2000 (R12)
    // `kick` returns the bounty; the kicked member gets `stake − fee` (plus claimable, 0 here).
    expect(game.call(HOLDER, (sim, env) => sim.kick(env, lazy))).toBe(bounty);
    expect(game.sim.ftBalanceOf(HOLDER)).toBe(holderBalance + bounty);
    expect(game.sim.ftBalanceOf(lazy)).toBe(lazyBalance + lazyStake - fee);
    expect(game.sim.state.total_supply).toBe(supply - (fee - bounty));
    expect(game.sim.state.open.goal).toBe(4); // today's goal is fixed
    game.goToDay(5);
    game.settle();
    expect(game.sim.state.open.goal).toBe(3); // ceil(5 × 0.6)
  });

  test("a self-kick costs less than leave by the bounty (API.md Limits)", () => {
    const leaveGame = activeGame(3);
    const kickGame = activeGame(3);
    for (const { game } of [leaveGame, kickGame]) {
      game.goToDay(5);
      game.settle(); // days 1–4 failed: stakes are slashed before the exit
    }
    const leaver = leaveGame.accounts[0] as string;
    const kicker = kickGame.accounts[0] as string;
    const stake = leaveGame.game.sim.getMember(leaveGame.game.env(HOLDER), leaver)?.effective_stake ?? 0n;
    const fee = (stake * 1000n) / B;
    expect(leaveGame.game.call(leaver, (sim, env) => sim.leave(env))).toBe(stake - fee);
    expect(kickGame.game.call(kicker, (sim, env) => sim.kick(env, kicker))).toBe((fee * 2000n) / B);
    expect(kickGame.game.sim.ftBalanceOf(kicker) - leaveGame.game.sim.ftBalanceOf(leaver)).toBe((fee * 2000n) / B);
  });

  test("an unregistered kicker gets no bounty: the whole fee burns (R12)", () => {
    const { game, accounts } = activeGame(3);
    game.goToDay(5);
    game.settle();
    const supply = game.sim.state.total_supply;
    const stake = game.sim.getMember(game.env(HOLDER), accounts[0] as string)?.effective_stake ?? 0n;
    const fee = (stake * 1000n) / B;
    expect(game.call("stranger.test.near", (sim, env) => sim.kick(env, accounts[0] as string))).toBe(0n);
    expect(game.sim.state.total_supply).toBe(supply - fee);
  });

  test("a backlog above the cap refuses game calls but not transfers or settle", () => {
    const { game, accounts } = activeGame(3);
    game.goToDay(AUTO_SETTLE_CAP + 2);
    const before = structuredClone(game.sim.state);
    expect(errorCode(() => game.checkIn(accounts[0] as string))).toBe("ERR_BACKLOG");
    expect(game.sim.state).toEqual(before);
    game.call(accounts[0] as string, (sim, env) => sim.ftTransfer(env, HOLDER, 1n));
    expect(game.settle()).toBe(AUTO_SETTLE_CAP + 1); // days 1 .. 51; day 1 was already open
    expect(game.checkIn(accounts[0] as string).day).toBe(AUTO_SETTLE_CAP + 2);
  });
});

describe("other methods", () => {
  test("a failed call changes nothing", () => {
    const { game, accounts } = activeGame(3);
    game.checkIn(accounts[0] as string);
    const before = structuredClone(game.sim.state);
    expect(errorCode(() => game.checkIn(accounts[0] as string))).toBe("ERR_ALREADY_CHECKED_IN");
    expect(errorCode(() => game.call("poor.test.near", (sim, env) => sim.join(env)))).toBe("ERR_NOT_REGISTERED");
    expect(game.sim.state).toEqual(before);
  });

  test("join refuses members, bad keys, and short balances", () => {
    const game = new Game();
    const [alice] = game.joinMany(1) as [string];
    expect(errorCode(() => game.call(alice, (sim, env) => sim.join(env)))).toBe("ERR_ALREADY_MEMBER");
    game.fund("bob.test.near", 1n);
    expect(errorCode(() => game.call("bob.test.near", (sim, env) => sim.join(env, "secp256k1:abc")))).toBe(
      "ERR_BAD_KEY"
    );
    expect(errorCode(() => game.call("bob.test.near", (sim, env) => sim.join(env)))).toBe("ERR_INSUFFICIENT_BALANCE");
  });

  test("check_in_signed checks the key and the day", () => {
    const { game, accounts } = activeGame(3);
    const alice = accounts[0] as string;
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.checkInSigned(env, alice, 1)))).toBe(
      "ERR_NO_CHECKIN_KEY"
    );
    game.call(alice, (sim, env) => sim.setCheckinKey(env, "ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z"));
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.checkInSigned(env, alice, 0)))).toBe("ERR_BAD_DAY");
    expect(game.call(HOLDER, (sim, env) => sim.checkInSigned(env, alice, 1))).toMatchObject({ day: 1, n: 1 });
    // Item 22c: a direct check-in on the same day is refused.
    expect(errorCode(() => game.checkIn(alice))).toBe("ERR_ALREADY_CHECKED_IN");
  });

  test("faucet: once per account, refused when empty or disabled (item 22)", () => {
    const game = new Game({ args: { faucet_bps: 1 }, config: { faucet_amount: 6n * 10n ** 22n } });
    // faucet_left = 10^27 / 10^4 = 10^23 tokens: one payout of 6 × 10^22 fits, a second does not.
    for (const account of ["a.test.near", "b.test.near"]) {
      game.call(account, (sim, env) => sim.storageDeposit(env, account));
    }
    expect(game.call("a.test.near", (sim, env) => sim.faucet(env))).toBe(6n * 10n ** 22n);
    expect(errorCode(() => game.call("a.test.near", (sim, env) => sim.faucet(env)))).toBe("ERR_FAUCET_USED");
    expect(errorCode(() => game.call("b.test.near", (sim, env) => sim.faucet(env)))).toBe("ERR_FAUCET_EMPTY");

    const mainnetLike = new Game({ args: { faucet_bps: 0 }, config: { faucet_amount: 0n } });
    expect(errorCode(() => mainnetLike.call(HOLDER, (sim, env) => sim.faucet(env)))).toBe("ERR_FAUCET_DISABLED");
  });

  test("transfers to the contract itself must go through join (item 21)", () => {
    const game = new Game();
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.ftTransfer(env, CONTRACT, 1n)))).toBe("ERR_USE_JOIN");
    const [alice] = game.joinMany(1) as [string];
    expect(errorCode(() => game.call(alice, (sim, env) => sim.storageUnregister(env)))).toBe(
      "ERR_MEMBER_CANNOT_UNREGISTER"
    );
  });

  test("errors are ContractError instances with the code as message", () => {
    const game = new Game();
    try {
      game.checkIn("x.test.near");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).message).toBe("ERR_NOT_MEMBER");
    }
  });
});
