import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { AUTO_SETTLE_CAP, B, heroIndex, MAX_SETTLE_DAYS } from "./engine";
import { errorCode, Game, HOLDER } from "./test-harness";

// One test per formula of plan section 4.4 that a regression could change silently. Every expected
// value is computed here from the plan's text with literal numbers, never read back from the engine,
// so a wrong formula cannot agree with itself. Demo parameters: emit 100, step 1000, J = 10,
// burn 500, slash 1000 (b), goal 60%, min_goal 3, warmup 1, inactive 3.

const E8 = 100_000_000n;
const S = 10n ** 21n; // demo join_stake

function activeGame(members: number, options: ConstructorParameters<typeof Game>[0] = {}) {
  const game = new Game(options);
  const accounts = game.joinMany(members);
  game.goToDay(game.config.warmup_days);
  game.settle(); // opens the activation day
  return { game, accounts };
}

/** The plan's hero hash, written independently: sha256(seed ‖ day u32 LE ‖ "lastcall"), u64 LE. */
function referenceHeroIndex(seed: Uint8Array, day: number, tickets: number): number {
  const dayBytes = Buffer.alloc(4);
  dayBytes.writeUInt32LE(day);
  const digest = createHash("sha256").update(seed).update(dayBytes).update("lastcall").digest();
  return Number(digest.readBigUInt64LE(0) % BigInt(tickets));
}

describe("success day", () => {
  test("per_share divides the budget by count + J, including members who left (forfeited)", () => {
    const { game, accounts } = activeGame(4); // goal 3
    for (const account of accounts) game.checkIn(account);
    game.call(accounts[0] as string, (sim, env) => sim.leave(env)); // forfeits day 1
    const pot = game.sim.state.pot;
    game.goToDay(2);
    game.settle();

    const budget = (pot * 100n * 11_000n) / E8; // streak 1: mult = B + 1 × 1000
    const perShare = budget / (4n + 10n); // count 4, not count - forfeited
    const summary = game.sim.getHistory(1)[0];
    expect(summary?.per_share).toBe(perShare);
    expect(game.sim.state.reserved).toBe(perShare * 3n); // shares = count - forfeited
    expect(game.sim.state.total_rewarded).toBe(perShare * 3n);
    expect(game.sim.state.pot).toBe(pot - perShare * 3n - perShare * 10n);
  });

  test("a failure after a success resets the streak and keeps the record", () => {
    const { game, accounts } = activeGame(3);
    for (const account of accounts) game.checkIn(account);
    game.goToDay(3); // day 2: nobody checks in
    game.settle();
    const [day2, day1] = game.sim.getHistory(2);
    expect(day1).toMatchObject({ day: 1, outcome: "Success", streak_after: 1 });
    expect(day2).toMatchObject({ day: 2, outcome: "Fail", streak_after: 0 });
    expect(game.sim.state).toMatchObject({ streak: 0, longest_streak: 1 });
  });
});

describe("failed day", () => {
  test("checked_stake adds the member's current, already slashed stake", () => {
    const { game, accounts } = activeGame(5); // goal 3
    game.goToDay(2); // day 1 fails: nobody checked in
    game.checkIn(accounts[0] as string); // day 2: one check-in, fails again
    const slashedStake = S - S / 10n;
    expect(game.sim.state.open.checked_stake).toBe(slashedStake);
    game.goToDay(3);
    game.settle();

    const activeAfterDay1 = 5n * S - (5n * S) / 10n;
    const expectedSlash = ((activeAfterDay1 - slashedStake) * 1000n) / B; // 3.6 × 10^20
    expect(expectedSlash).toBe(36n * 10n ** 19n);
    expect(game.sim.getHistory(1)[0]).toMatchObject({ day: 2, outcome: "Fail", stake_slashed: expectedSlash });
  });

  test("a failed day during a member's warmup does not slash that member", () => {
    const { game } = activeGame(3); // day 1 is open with goal 3
    const [late] = game.joinMany(1, "late") as [string]; // joins on day 1, active from day 2
    game.goToDay(2); // day 1 fails
    game.settle();
    expect(game.sim.state.failed_days.has(1)).toBe(true);
    expect(game.sim.getMember(game.env(HOLDER), late)?.effective_stake).toBe(S);
    expect(game.sim.getMember(game.env(HOLDER), "player-0.test.near")?.effective_stake).toBe(S - S / 10n);
  });
});

describe("exit", () => {
  test("the fee rounds down for a stake not divisible by 10", () => {
    const stake = 10n ** 21n + 7n;
    const { game, accounts } = activeGame(3, { config: { join_stake: stake } });
    const supply = game.sim.state.total_supply;
    // fee = floor((10^21 + 7) × 1000 / 10 000) = 10^20 (the 0.7 is dropped)
    expect(game.call(accounts[0] as string, (sim, env) => sim.leave(env))).toBe(stake - 10n ** 20n);
    expect(game.sim.state.total_supply).toBe(supply - 10n ** 20n);
  });

  test("a member who checked in is kickable from last_checkin + 1 + inactive_days", () => {
    const { game, accounts } = activeGame(3);
    const alice = accounts[0] as string;
    game.checkIn(alice); // day 1
    expect(game.sim.getMember(game.env(HOLDER), alice)?.kickable_from_day).toBe(5);
    game.goToDay(4);
    expect(errorCode(() => game.call(HOLDER, (sim, env) => sim.kick(env, alice)))).toBe("ERR_NOT_INACTIVE");
    game.goToDay(5);
    expect(game.call(HOLDER, (sim, env) => sim.kick(env, alice))).toBeGreaterThan(0n);
  });
});

describe("settling", () => {
  test("a backlog of exactly AUTO_SETTLE_CAP days is settled; one more is refused", () => {
    expect(AUTO_SETTLE_CAP).toBe(50);
    const atCap = activeGame(3); // last settled 0, day 1 open
    atCap.game.goToDay(51); // pending = 51 - 1 = 50
    expect(atCap.game.checkIn(atCap.accounts[0] as string).day).toBe(51);

    const overCap = activeGame(3);
    overCap.game.goToDay(52); // pending = 51
    expect(errorCode(() => overCap.game.checkIn(overCap.accounts[0] as string))).toBe("ERR_BACKLOG");
  });

  test("settle(None) settles at most MAX_SETTLE_DAYS per call", () => {
    expect(MAX_SETTLE_DAYS).toBe(500);
    const { game } = activeGame(3);
    game.goToDay(601); // days 1 .. 600 pending
    expect(game.settle()).toBe(500);
    expect(game.settle()).toBe(100);
    expect(game.settle()).toBe(0);
  });
});

describe("hero", () => {
  test("the hash matches the plan's byte layout on a fixed vector", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(heroIndex(seed, 7, 5)).toBe(referenceHeroIndex(seed, 7, 5));
    // Literal values, computed once from the reference: they pin the layout even if both change.
    expect([0, 1, 7, 64, 65_536].map((day) => heroIndex(seed, day, 5))).toEqual(
      [0, 1, 7, 64, 65_536].map((day) => referenceHeroIndex(seed, day, 5))
    );
  });

  test("the hash agrees with the reference on random seeds, days, and window sizes", () => {
    let state = 12_345;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state;
    };
    for (let index = 0; index < 500; index += 1) {
      const seed = Uint8Array.from({ length: 32 }, () => next() % 256);
      const day = next() % 100_000;
      const tickets = 1 + (next() % 600);
      expect(heroIndex(seed, day, tickets)).toBe(referenceHeroIndex(seed, day, tickets));
    }
  });

  test("pick_hero pays the reference hero and counts it", () => {
    const { game, accounts } = activeGame(5, { autoPickHero: false });
    for (const account of accounts) game.checkIn(account);
    game.goToDay(2);
    game.settle();
    const seed = new Uint8Array(32).fill(9);
    // goal 3 and check-ins in account order: ticket i + 1 belongs to accounts[i].
    const tickets = game.sim.state.pending_hero?.tickets ?? 0;
    expect(tickets).toBe(3);
    const hero = accounts[referenceHeroIndex(seed, 1, tickets)] as string;

    game.runPickHero(seed);
    expect(game.sim.getHistory(1)[0]?.hero).toBe(hero);
    expect(game.sim.getMember(game.env(HOLDER), hero)?.hero_count).toBe(1);
  });
});

describe("personal streaks", () => {
  test("consecutive check-ins grow the streak; a gap restarts it; the best is kept", () => {
    const { game, accounts } = activeGame(1);
    const alice = accounts[0] as string;
    const member = () => game.sim.getMember(game.env(HOLDER), alice);
    game.checkIn(alice); // day 1
    game.goToDay(2);
    game.checkIn(alice);
    expect(member()).toMatchObject({ personal_streak: 2, best_personal_streak: 2, checkins: 2 });
    game.goToDay(4); // day 3 skipped
    game.checkIn(alice);
    expect(member()).toMatchObject({ personal_streak: 1, best_personal_streak: 2, checkins: 3 });
  });
});
