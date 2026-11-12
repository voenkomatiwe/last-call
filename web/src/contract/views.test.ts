import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ContractShapeError } from "./decode";
import {
  parseBalance,
  parseCheckInResult,
  parseConfig,
  parseHistory,
  parseKickablePage,
  parseMember,
  parseOpenDay,
  parseState,
  parseStorageBalance,
  parseStorageBalanceBounds,
} from "./views";

const CONTRACT_SRC = join(import.meta.dir, "../../../contract/src");

/** The serde field names of a `pub struct` in the contract source (flattened fields excluded). */
async function contractFields(file: string, struct: string): Promise<string[]> {
  const source = await Bun.file(join(CONTRACT_SRC, file)).text();
  const start = source.indexOf(`pub struct ${struct} {`);
  if (start === -1) throw new Error(`pub struct ${struct} not found in ${file}`);
  const body = source.slice(start, source.indexOf("\n}", start));
  const fields: string[] = [];
  let flatten = false;
  for (const line of body.split("\n")) {
    if (line.includes("#[serde(flatten)]")) flatten = true;
    const match = line.match(/^\s+pub ([a-z_0-9]+):/);
    if (!match?.[1]) continue;
    if (!flatten) fields.push(match[1]);
    flatten = false;
  }
  return fields;
}

// JSON shapes asserted by the contract's own tests in `contract/src/types.rs`.
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
const DAY_SUMMARY_JSON =
  '{"day":9,"outcome":"Idle","goal":0,"count":2,"streak_after":4,"per_share":"0",' +
  '"hero":"alice.near","jackpot":"0","pot_burned":"0","stake_slashed":"0","pot_after":"123"}';

const STATE_JSON = {
  today: 12,
  last_settled: 11,
  pending_days: 0,
  pot: "500000000000000000000000000",
  reserved: "10",
  stake_pool: "20",
  faucet_left: "0",
  jackpot_pending: "0",
  pending_hero_days: [11],
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
const OPEN_DAY_JSON = {
  day: 12,
  goal: 5,
  count: 2,
  active: 7,
  forfeited: 0,
  closers: ["alice.near", "bob.near"],
  is_idle: false,
  stale: false,
};
const MEMBER_JSON = {
  stake: "1000",
  join_day: 1,
  activation_day: 3,
  last_checkin: null,
  resolved_through: 5,
  claimable: "7",
  checkins: 0,
  personal_streak: 0,
  best_personal_streak: 0,
  hero_count: 0,
  storage_deposit: "10000000000000000000000",
  checkin_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp",
  effective_stake: "900",
  pending_claimable: "7",
  is_active: true,
  checked_in_today: false,
  can_check_in_today: true,
  current_personal_streak: 0,
  kickable_from_day: 6,
};

describe("field lists match the contract source", () => {
  test.each([
    ["types.rs", "StateView", STATE_JSON],
    ["types.rs", "OpenDayView", OPEN_DAY_JSON],
    ["types.rs", "MemberView", MEMBER_JSON],
    ["types.rs", "DaySummary", JSON.parse(DAY_SUMMARY_JSON)],
  ])("%s %s", async (file, struct, sample) => {
    expect(Object.keys(sample).sort()).toEqual((await contractFields(file, struct)).sort());
  });

  test("ConfigView = Config fields + the deploy-time fields", async () => {
    const expected = [
      ...(await contractFields("config.rs", "Config")),
      ...(await contractFields("types.rs", "ConfigView")),
    ];
    expect(Object.keys(CONFIG_JSON).sort()).toEqual(expected.sort());
  });
});

describe("parsers", () => {
  test("get_config: the flat shape from the contract test", () => {
    const config = parseConfig(CONFIG_JSON);
    expect(config.closersK).toBe(5);
    expect(config.kickBountyBps).toBe(2000);
    expect(config.joinStake).toBe(1_000_000_000_000_000_000_000n);
    expect(config.launchNs).toBe(1_800_000_000_000_000_000n);
  });

  test("get_history: the day summary from the contract test", () => {
    const [day] = parseHistory([JSON.parse(DAY_SUMMARY_JSON)]);
    expect(day).toEqual({
      day: 9,
      outcome: "Idle",
      goal: 0,
      count: 2,
      streakAfter: 4,
      perShare: 0n,
      jackpot: 0n,
      hero: "alice.near",
      potBurned: 0n,
      stakeSlashed: 0n,
      potAfter: 123n,
    });
  });

  test("CheckInResult and KickablePage from the contract test", () => {
    expect(parseCheckInResult(JSON.parse('{"day":3,"n":4,"goal":5,"in_closers":false}'))).toEqual({
      day: 3,
      n: 4,
      goal: 5,
      inClosers: false,
    });
    expect(parseKickablePage(JSON.parse('{"accounts":["alice.near"],"next_index":null}'))).toEqual({
      accounts: ["alice.near"],
      nextIndex: null,
    });
  });

  test("get_state, get_open_day, get_member", () => {
    const state = parseState(STATE_JSON);
    expect(state.pot).toBe(500_000_000_000_000_000_000_000_000n);
    expect(state.pendingHeroDays).toEqual([11]);
    expect(parseState({ ...STATE_JSON, last_settled: null }).lastSettled).toBeNull();
    expect(parseOpenDay(OPEN_DAY_JSON).closers).toEqual(["alice.near", "bob.near"]);
    const member = parseMember(MEMBER_JSON);
    expect(member?.lastCheckin).toBeNull();
    expect(member?.kickableFromDay).toBe(6);
    expect(parseMember(null)).toBeNull();
  });

  test("storage_balance_of: null for an unregistered account", () => {
    expect(parseStorageBalance(null)).toBeNull();
    expect(parseStorageBalance({ total: "125", available: "0" })).toEqual({ total: 125n, available: 0n });
  });
});

describe("untrusted input is rejected", () => {
  test.each([
    ["a missing field", { ...STATE_JSON, pot: undefined }],
    ["a number amount", { ...STATE_JSON, pot: 5 }],
    ["a hex amount", { ...STATE_JSON, pot: "0x10" }],
    ["a negative day", { ...STATE_JSON, today: -1 }],
    ["a fractional day", { ...STATE_JSON, today: 1.5 }],
    ["an amount above u128", { ...STATE_JSON, pot: (1n << 128n).toString() }],
    ["a leading zero", { ...STATE_JSON, pot: "01" }],
  ])("get_state with %s", (_name, value) => {
    const json = JSON.parse(JSON.stringify(value));
    expect(() => parseState(json)).toThrow(ContractShapeError);
  });

  test("an invalid account in closers, a bad outcome, a non-object", () => {
    expect(() => parseOpenDay({ ...OPEN_DAY_JSON, closers: ["Not An Account"] })).toThrow(ContractShapeError);
    expect(() => parseHistory([{ ...JSON.parse(DAY_SUMMARY_JSON), outcome: "Win" }])).toThrow(ContractShapeError);
    expect(() => parseMember([])).toThrow(ContractShapeError);
    expect(() => parseHistory({})).toThrow(ContractShapeError);
  });

  test("the error names the field", () => {
    expect(() => parseMember({ ...MEMBER_JSON, stake: 1 })).toThrow("get_member.stake: expected a U128 decimal string");
  });
});

describe("token views reject untrusted input", () => {
  test("ft_balance_of", () => {
    expect(parseBalance("125")).toBe(125n);
    for (const bad of [125, "1.5", "-1", null, undefined]) expect(() => parseBalance(bad)).toThrow(ContractShapeError);
  });

  test("storage_balance_bounds", () => {
    expect(parseStorageBalanceBounds({ min: "125", max: null })).toEqual({ min: 125n, max: null });
    expect(parseStorageBalanceBounds({ min: "125", max: "125" })).toEqual({ min: 125n, max: 125n });
    expect(() => parseStorageBalanceBounds({ max: null })).toThrow(ContractShapeError);
    expect(() => parseStorageBalanceBounds({ min: 125, max: null })).toThrow(ContractShapeError);
    expect(() => parseStorageBalanceBounds({ min: "0x7d", max: null })).toThrow(ContractShapeError);
  });

  test("storage_balance_of", () => {
    expect(() => parseStorageBalance({ total: "1" })).toThrow(ContractShapeError);
    expect(() => parseStorageBalance({ total: 1, available: "0" })).toThrow(ContractShapeError);
  });

  test.each([
    ["get_open_day", parseOpenDay, OPEN_DAY_JSON, "count"],
    ["get_member", parseMember, MEMBER_JSON, "claimable"],
    ["get_config", parseConfig, CONFIG_JSON, "join_stake"],
  ] as const)("%s: missing field and non-decimal amount", (_name, parse, sample, key) => {
    const missing: Record<string, unknown> = { ...sample };
    delete missing[key];
    expect(() => parse(missing)).toThrow(ContractShapeError);
    expect(() => parse({ ...sample, [key]: "12a" })).toThrow(ContractShapeError);
  });
});
