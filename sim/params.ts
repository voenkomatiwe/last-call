import paramsFile from "../config/params.json";
import { type Config, type NewArgs, validateNewArgs } from "./engine";

// `config/params.json` is the single source of parameters (plan section 3): the simulation, the
// demo, the deploy script, and the Rust tests all read it. Token metadata is a `new` argument,
// not part of this file. Amounts are strings there (u128 in JSON).

export const NETWORKS = ["mainnet", "testnet", "demo"] as const;
export type ParamsNetwork = (typeof NETWORKS)[number];

export interface ParamsSet {
  readonly config: Config;
  readonly total_supply: bigint;
  readonly pot_bps: number;
  readonly faucet_bps: number;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)$/;

function amount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value)) {
    throw new Error(`${field} must be a decimal string of a non-negative integer`);
  }
  return BigInt(value);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

const INTEGER_FIELDS = [
  "day_length_s",
  "warmup_days",
  "inactive_days",
  "goal_bps",
  "min_goal",
  "closers_k",
  "jackpot_mult",
  "emit_bps",
  "streak_step_bps",
  "streak_cap",
  "burn_bps",
  "slash_bps",
  "kick_bounty_bps",
] as const;

/** Parses one set and checks it with the rules of `new` (plan section 4.2). */
export function parseParamsSet(raw: unknown, name: string): ParamsSet {
  if (typeof raw !== "object" || raw === null) throw new Error(`${name} is not an object`);
  const set = raw as Record<string, unknown>;
  const rawConfig = set.config as Record<string, unknown> | undefined;
  if (typeof rawConfig !== "object" || rawConfig === null) throw new Error(`${name}.config is not an object`);

  const integers = Object.fromEntries(
    INTEGER_FIELDS.map((field) => [field, integer(rawConfig[field], `${name}.config.${field}`)])
  ) as Record<(typeof INTEGER_FIELDS)[number], number>;
  const config: Config = {
    ...integers,
    join_stake: amount(rawConfig.join_stake, `${name}.config.join_stake`),
    member_storage_deposit: amount(rawConfig.member_storage_deposit, `${name}.config.member_storage_deposit`),
    faucet_amount: amount(rawConfig.faucet_amount, `${name}.config.faucet_amount`),
  };

  const params: ParamsSet = {
    config,
    total_supply: amount(set.total_supply, `${name}.total_supply`),
    pot_bps: integer(set.pot_bps, `${name}.pot_bps`),
    faucet_bps: integer(set.faucet_bps, `${name}.faucet_bps`),
  };
  validateNewArgs(newArgs(params, "validation.placeholder"));
  return params;
}

export function newArgs(params: ParamsSet, initialHolder: string): NewArgs {
  return {
    config: params.config,
    total_supply: params.total_supply,
    pot_bps: params.pot_bps,
    faucet_bps: params.faucet_bps,
    initial_holder: initialHolder,
  };
}

export function loadParams(network: ParamsNetwork): ParamsSet {
  return parseParamsSet((paramsFile as Record<string, unknown>)[network], network);
}
