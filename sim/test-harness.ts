import { type Config, type Env, LastCallSim, type NewArgs } from "./engine";
import { checkInvariants } from "./invariants";
import { loadParams, newArgs, type ParamsNetwork } from "./params";

// A small chain around the simulator for tests: block time and height, seeds for pick_hero, funded
// accounts, and an invariant check after every step.

export const CONTRACT = "lastcall.test.near";
export const HOLDER = "holder.test.near";
const LAUNCH_NS = 1_800_000_000n * 1_000_000_000n;

/** Deterministic PRNG (mulberry32) so failures reproduce from their seed. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GameOptions {
  /** The parameter set from config/params.json (default demo). */
  readonly network?: ParamsNetwork;
  readonly config?: Partial<Config>;
  readonly args?: Partial<Omit<NewArgs, "config">>;
  /** Run scheduled pick_hero promises automatically in the next block (default true). */
  readonly autoPickHero?: boolean;
  readonly seed?: number;
}

export class Game {
  readonly sim: LastCallSim;
  readonly dayNs: bigint;
  tNs = LAUNCH_NS;
  height = 1;
  autoPickHero: boolean;
  private readonly random: () => number;

  constructor(options: GameOptions = {}) {
    const base = newArgs(loadParams(options.network ?? "demo"), HOLDER);
    const args: NewArgs = { ...base, ...options.args, config: { ...base.config, ...options.config } };
    this.sim = LastCallSim.deploy({ tNs: this.tNs, height: this.height, signer: CONTRACT }, args);
    this.dayNs = BigInt(args.config.day_length_s) * 1_000_000_000n;
    this.autoPickHero = options.autoPickHero ?? true;
    this.random = prng(options.seed ?? 1);
    this.assertInvariants("after new");
  }

  get config(): Config {
    return this.sim.state.config;
  }

  get today(): number {
    return this.sim.today(this.env(CONTRACT));
  }

  env(signer: string, seed?: Uint8Array): Env {
    return { tNs: this.tNs, height: this.height, signer, ...(seed ? { seed } : {}) };
  }

  randomSeed(): Uint8Array {
    return Uint8Array.from({ length: 32 }, () => Math.floor(this.random() * 256));
  }

  /** Moves the clock to the middle of `day` (or to `fraction` of it). */
  goToDay(day: number, fraction = 0.5): void {
    const tNs = LAUNCH_NS + BigInt(day) * this.dayNs + BigInt(Math.floor(Number(this.dayNs) * fraction));
    if (tNs < this.tNs) throw new Error(`time cannot go back to day ${day}`);
    this.tNs = tNs;
    this.height += 1;
  }

  /**
   * One transaction in a new block (or in the current block with `sameBlock`). Scheduled
   * pick_hero promises run in the next block, and the invariants are checked after both.
   */
  call<T>(signer: string, action: (sim: LastCallSim, env: Env) => T, options: { sameBlock?: boolean } = {}): T {
    if (!options.sameBlock) this.height += 1;
    try {
      return action(this.sim, this.env(signer));
    } finally {
      if (this.autoPickHero) this.runPickHero();
      this.assertInvariants(`after a call by ${signer}`);
    }
  }

  /** Executes the scheduled pick_hero promises one block later, each with a fresh seed. */
  runPickHero(seed?: Uint8Array): void {
    for (const scheduled of this.sim.takeScheduled()) {
      this.height += 1;
      this.sim.pickHero(this.env(CONTRACT, seed ?? this.randomSeed()), scheduled.day);
    }
  }

  assertInvariants(when: string): void {
    const violations = checkInvariants(this.sim);
    if (violations.length > 0) throw new Error(`Invariants broken ${when}:\n${violations.join("\n")}`);
  }

  /** Registers an account and gives it tokens from the initial holder. */
  fund(accountId: string, amount: bigint = this.config.join_stake * 10n): void {
    this.call(accountId, (sim, env) => sim.storageDeposit(env, accountId));
    this.call(HOLDER, (sim, env) => sim.ftTransfer(env, accountId, amount));
  }

  /** Funds and joins `count` accounts named `<prefix>-<n>.test.near`. */
  joinMany(count: number, prefix = "player"): string[] {
    const accounts = Array.from({ length: count }, (_, index) => `${prefix}-${index}.test.near`);
    for (const accountId of accounts) {
      this.fund(accountId);
      this.call(accountId, (sim, env) => sim.join(env));
    }
    return accounts;
  }

  checkIn(accountId: string, options: { sameBlock?: boolean } = {}) {
    return this.call(accountId, (sim, env) => sim.checkIn(env), options);
  }

  /** Settles every pending day through the public `settle`. */
  settle(): number {
    return this.call(HOLDER, (sim, env) => sim.settle(env));
  }
}

/** Runs `action` and returns the contract error code it throws, or fails if it does not throw. */
export function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && "code" in error) return String(error.code);
    throw error;
  }
  throw new Error("expected a contract error");
}
