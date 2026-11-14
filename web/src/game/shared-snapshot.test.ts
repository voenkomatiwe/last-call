import { describe, expect, test } from "bun:test";

import { ContractShapeError } from "../contract/decode";
import { createSharedHandler, SHARED_CACHE_CONTROL, SHARED_SERVER_TTL_MS } from "./shared-handler";
import { KICKABLE_REFRESH_MS, parseShared, parseSharedResponse, readShared, type ViewFn } from "./shared-snapshot";

// Contract JSON shapes, as asserted in contract/views.test.ts.
const CONFIG_JSON = {
  day_length_s: 60,
  warmup_days: 1,
  goal_bps: 6000,
  min_goal: 3,
  closers_k: 5,
  jackpot_mult: 10,
  emit_bps: 100,
  streak_step_bps: 1000,
  streak_cap: 10,
  burn_bps: 500,
  slash_bps: 1000,
  join_stake: "1000000000000000000000",
  member_storage_deposit: "10000000000000000000000",
  faucet_amount: "5000000000000000000000",
  inactive_days: 3,
  kick_bounty_bps: 2000,
  pot_bps: 5000,
  faucet_bps: 100,
  initial_supply: "1000",
  launch_ns: "1800000000000000000",
  auto_settle_cap: 50,
  max_settle_days: 500,
  history_len: 64,
};
const BOUNDS_JSON = { min: "1250000000000000000000", max: "1250000000000000000000" };
function stateJson(lastSettled: number, pendingHeroDays: number[] = []) {
  return {
    today: lastSettled + 1,
    last_settled: lastSettled,
    pending_days: 0,
    pot: "500000000000000000000000000",
    reserved: "10",
    stake_pool: "20",
    faucet_left: "0",
    jackpot_pending: "0",
    pending_hero_days: pendingHeroDays,
    streak: 3,
    longest_streak: 4,
    active_count: 7,
    active_stake: "20",
    members_total: 8,
    total_supply: "1000000000000000000000000000",
    total_burned: "0",
    total_rewarded: "0",
    total_jackpots: "0",
    ms_to_day_end: 41_000,
  };
}
const OPEN_DAY_JSON = {
  day: 12,
  goal: 5,
  count: 2,
  active: 7,
  forfeited: 0,
  closers: ["alice.near"],
  is_idle: false,
  stale: false,
};
const DAY_JSON = {
  day: 11,
  outcome: "Idle",
  goal: 0,
  count: 2,
  streak_after: 4,
  per_share: "0",
  hero: null,
  jackpot: "0",
  pot_burned: "0",
  stake_slashed: "0",
  pot_after: "123",
};

/** A fake contract that counts calls per method. */
function fakeContract(options: { lastSettled?: () => number; kickableFails?: () => boolean } = {}) {
  const calls: Record<string, number> = {};
  const view: ViewFn = async (method, args) => {
    calls[method] = (calls[method] ?? 0) + 1;
    switch (method) {
      case "get_config":
        return CONFIG_JSON;
      case "storage_balance_bounds":
        return BOUNDS_JSON;
      case "get_state":
        return stateJson(options.lastSettled?.() ?? 11);
      case "get_open_day":
        return OPEN_DAY_JSON;
      case "get_history":
        return [DAY_JSON];
      case "get_kickable": {
        if (options.kickableFails?.()) throw new Error("rpc down");
        return args?.from_index === 0
          ? { accounts: ["bob.near"], next_index: 1 }
          : { accounts: ["carol.near"], next_index: null };
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { view, calls };
}

describe("readShared", () => {
  test("a first read reads every shared view and pages kickable members", async () => {
    const { view, calls } = fakeContract();
    const raw = await readShared(view, undefined, () => 1_000_000);
    const snapshot = parseShared(raw);
    expect(snapshot.state.lastSettled).toBe(11);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.kickable).toEqual(["bob.near", "carol.near"]);
    expect(raw.readAt).toBe(1_000_000);
    expect(calls).toEqual({
      get_config: 1,
      storage_balance_bounds: 1,
      get_state: 1,
      get_open_day: 1,
      get_history: 1,
      get_kickable: 2,
    });
  });

  test("a later read reuses config, bounds, unchanged history, and fresh kickable members", async () => {
    const { view, calls } = fakeContract();
    let now = 1_000_000;
    const first = await readShared(view, undefined, () => now);
    now += 3_000;
    const second = await readShared(view, first, () => now);
    expect(second.readAt).toBe(now);
    expect(calls).toMatchObject({ get_config: 1, storage_balance_bounds: 1, get_state: 2, get_open_day: 2 });
    expect(calls.get_history).toBe(1);
    expect(calls.get_kickable).toBe(2);
  });

  test("a settled day or a drawn hero re-reads history", async () => {
    let lastSettled = 11;
    const { view, calls } = fakeContract({ lastSettled: () => lastSettled });
    const first = await readShared(view, undefined, () => 1);
    lastSettled = 12;
    await readShared(view, first, () => 2);
    expect(calls.get_history).toBe(2);
  });

  test("kickable members are re-read after 30 s; a failure keeps the previous list", async () => {
    let fail = false;
    const { view, calls } = fakeContract({ kickableFails: () => fail });
    let now = 1_000_000;
    const first = await readShared(view, undefined, () => now);
    now += KICKABLE_REFRESH_MS;
    fail = true;
    const second = await readShared(view, first, () => now);
    expect(second.kickable).toEqual(["bob.near", "carol.near"]);
    expect(second.kickableAt).toBe(first.kickableAt);
    fail = false;
    const third = await readShared(view, second, () => now);
    expect(third.kickableAt).toBe(now);
    expect(calls.get_kickable).toBe(5);
  });

  test("a malformed live view rejects instead of being cached", async () => {
    const { view } = fakeContract();
    const broken: ViewFn = (method, args) => (method === "get_open_day" ? Promise.resolve({}) : view(method, args));
    await expect(readShared(broken)).rejects.toBeInstanceOf(ContractShapeError);
  });
});

describe("parseSharedResponse", () => {
  async function body() {
    const { view } = fakeContract();
    return { contractId: "v2.last-call.testnet", ageMs: 250, views: await readShared(view, undefined, () => 5) };
  }

  test("accepts a server answer for the expected contract", async () => {
    const parsed = parseSharedResponse(JSON.parse(JSON.stringify(await body())), "v2.last-call.testnet");
    expect(parsed.ageMs).toBe(250);
    expect(parseShared(parsed.views).openDay.count).toBe(2);
  });

  test("rejects another contract, a bad view, and a bad kickable entry", async () => {
    const good = await body();
    expect(() => parseSharedResponse(good, "other.testnet")).toThrow(ContractShapeError);
    expect(() =>
      parseSharedResponse({ ...good, views: { ...good.views, state: { today: 1 } } }, "v2.last-call.testnet")
    ).toThrow(ContractShapeError);
    expect(() =>
      parseSharedResponse({ ...good, views: { ...good.views, kickable: ["Not An Account"] } }, "v2.last-call.testnet")
    ).toThrow(ContractShapeError);
    expect(() => parseSharedResponse({ ...good, ageMs: -1 }, "v2.last-call.testnet")).toThrow(ContractShapeError);
  });
});

describe("GET /api/game handler", () => {
  const CONTRACT = "v2.last-call.testnet";

  test("concurrent requests share one RPC read and a fresh read is reused for 2 s", async () => {
    const { view, calls } = fakeContract();
    let now = 1_000_000;
    const handler = createSharedHandler(
      () => ({ contractId: CONTRACT, view }),
      () => now
    );

    const responses = await Promise.all([handler(), handler(), handler()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(calls.get_state).toBe(1);

    now += SHARED_SERVER_TTL_MS - 1;
    const cached = await handler();
    expect(calls.get_state).toBe(1);
    expect(cached.headers.get("cache-control")).toBe(SHARED_CACHE_CONTROL);
    expect(parseSharedResponse(await cached.json(), CONTRACT).ageMs).toBe(SHARED_SERVER_TTL_MS - 1);

    now += 1;
    await handler();
    expect(calls.get_state).toBe(2);
    // Config is read once per process; history and kickable members are reused.
    expect(calls.get_config).toBe(1);
    expect(calls.get_history).toBe(1);
  });

  test("a failed read answers 502 and the next request tries again", async () => {
    const { view } = fakeContract();
    let down = true;
    const flaky = (method: string, args?: Record<string, unknown>) =>
      down && method === "get_state" ? Promise.reject(new Error("rpc down")) : view(method, args);
    const handler = createSharedHandler(() => ({ contractId: CONTRACT, view: flaky }));

    const failed = await handler();
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toContain("rpc down");

    down = false;
    expect((await handler()).status).toBe(200);
  });

  test("an unconfigured server answers 503", async () => {
    const response = await createSharedHandler(() => undefined)();
    expect(response.status).toBe(503);
  });
});
