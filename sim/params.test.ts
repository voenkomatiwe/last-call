import { describe, expect, test } from "bun:test";

import paramsFile from "../config/params.json";
import { B, type NewArgs, U128_MAX, validateNewArgs } from "./engine";
import { loadParams, NETWORKS, newArgs, parseParamsSet } from "./params";

describe("config/params.json", () => {
  test("every set loads and passes the new() validation", () => {
    for (const network of NETWORKS) expect(() => loadParams(network)).not.toThrow();
  });

  test("matches plan section 3", () => {
    const mainnet = loadParams("mainnet");
    expect(mainnet.config).toMatchObject({
      day_length_s: 86_400,
      warmup_days: 2,
      inactive_days: 5,
      goal_bps: 6000,
      min_goal: 5,
      jackpot_mult: 10,
      emit_bps: 5,
      streak_step_bps: 1000,
      streak_cap: 30,
      burn_bps: 500,
      slash_bps: 1000,
      join_stake: 100_000n * 10n ** 18n,
      member_storage_deposit: 10n ** 22n,
      faucet_amount: 0n,
    });
    expect(mainnet).toMatchObject({ total_supply: 10n ** 27n, pot_bps: 5000, faucet_bps: 0 });

    expect(loadParams("testnet").config).toMatchObject({ ...mainnet.config, day_length_s: 600, inactive_days: 6 });

    const demo = loadParams("demo");
    expect(demo.config).toMatchObject({
      day_length_s: 60,
      warmup_days: 1,
      inactive_days: 3,
      min_goal: 3,
      emit_bps: 100,
      streak_cap: 10,
      join_stake: 1000n * 10n ** 18n,
      faucet_amount: 5000n * 10n ** 18n,
    });
    expect(demo.faucet_bps).toBe(100);
  });

  test("budget stays within the pot for every set: emit × (B + cap × step) ≤ 10^8", () => {
    for (const network of NETWORKS) {
      const { config } = loadParams(network);
      const bound = BigInt(config.emit_bps) * (B + BigInt(config.streak_cap) * BigInt(config.streak_step_bps));
      expect(bound).toBeLessThanOrEqual(100_000_000n);
    }
  });

  test("malformed sets are rejected with the field name", () => {
    const demo = (paramsFile as Record<string, unknown>).demo as Record<string, unknown>;
    const config = demo.config as Record<string, unknown>;
    expect(() => parseParamsSet({ ...demo, total_supply: 10 ** 27 }, "x")).toThrow("x.total_supply");
    expect(() => parseParamsSet({ ...demo, config: { ...config, join_stake: "-1" } }, "x")).toThrow(
      "x.config.join_stake"
    );
    expect(() => parseParamsSet({ ...demo, config: { ...config, warmup_days: 1.5 } }, "x")).toThrow(
      "x.config.warmup_days"
    );
  });
});

describe("new() validation (plan 4.2, section 5 item 26)", () => {
  const valid = newArgs(loadParams("demo"), "holder.test.near");
  const withConfig = (config: Partial<NewArgs["config"]>): NewArgs => ({
    ...valid,
    config: { ...valid.config, ...config },
  });

  test("the demo set is valid", () => {
    expect(() => validateNewArgs(valid)).not.toThrow();
  });

  test.each([
    ["warmup_days = 0", withConfig({ warmup_days: 0 })],
    ["inactive_days = 0", withConfig({ inactive_days: 0 })],
    ["pot_bps + faucet_bps > 10 000", { ...valid, pot_bps: 9950, faucet_bps: 100 }],
    ["budget > pot: emit 10 000 with ×4", withConfig({ emit_bps: 10_000, streak_cap: 30, streak_step_bps: 1000 })],
    ["total_supply > u128::MAX / 10^8", { ...valid, total_supply: U128_MAX / 100_000_000n + 1n }],
    ["min_goal = 0", withConfig({ min_goal: 0 })],
    ["day_length_s = 9", withConfig({ day_length_s: 9 })],
    ["join_stake = 0", withConfig({ join_stake: 0n })],
    ["a bps above 10 000", withConfig({ slash_bps: 10_001 })],
  ])("%s is ERR_BAD_CONFIG", (_name, args) => {
    expect(() => validateNewArgs(args)).toThrow("ERR_BAD_CONFIG");
  });
});
