//! Game parameters (spec S2), constants (S4) and the `new` parameter checks (S3).

use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, env, near, require};

use crate::errors::ERR_BAD_CONFIG;

/// `B`: the basis-point base.
pub const BPS_BASE: u128 = 10_000;
/// `10^8 = B²`: the denominator of `budget = pot × emit_bps × mult_bps / 10^8` (S3, S8).
pub const BUDGET_DENOM: u128 = BPS_BASE * BPS_BASE;

/// At most this many pending days are settled by a game call; more → `ERR_BACKLOG` (S5).
pub const AUTO_SETTLE_CAP: u32 = 50;
/// Upper bound of days per `settle` call (S5).
pub const MAX_SETTLE_DAYS: u32 = 500;
/// Size of the history ring: `history[d % HISTORY_LEN]` (S4).
pub const HISTORY_LEN: u32 = 64;
/// Static gas of the `pick_hero` promise (S8, S11). TODO(C11): measure, set to 1.5 × measured.
pub const PICK_HERO_GAS: Gas = Gas::from_tgas(10);
/// Gas kept for the rest of the call when a `pick_hero` promise is scheduled (S5).
pub const GAS_RESERVE: Gas = Gas::from_tgas(5);
/// Upper bound of the storage one `join` adds: member record with a 64-byte `AccountId` and a
/// `checkin_key`, its `IterableMap` index entry and a new `maturing` entry (S3, S4).
/// TODO(C6): замерить. Rough estimate ~400 bytes; 500 keeps `member_storage_deposit = 10^22`
/// (1000 bytes at 10^19 yocto/byte) valid.
pub const MAX_MEMBER_BYTES: u64 = 500;
/// Upper bound of `closers_k` (S3).
pub const MAX_CLOSERS_K: u32 = 16;
/// Lower bound of `day_length_s` (S3).
pub const MIN_DAY_LENGTH_S: u64 = 10;
/// Upper bound of `day_length_s`: 365 days (S3). Keeps `day_length_s × 10^9` far from `u64::MAX`.
pub const MAX_DAY_LENGTH_S: u64 = 31_536_000;
/// Upper bound of `jackpot_mult` (S3). Keeps `count + jackpot_mult` far from `u32::MAX`.
pub const MAX_JACKPOT_MULT: u32 = 1_000;

/// Game parameters (S2). Fixed at `new`; there is no method to change them.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub day_length_s: u64,
    pub warmup_days: u32,
    pub goal_bps: u16,
    pub min_goal: u32,
    pub closers_k: u32,
    pub jackpot_mult: u32,
    pub emit_bps: u16,
    pub streak_step_bps: u16,
    pub streak_cap: u32,
    pub burn_bps: u16,
    pub slash_bps: u16,
    pub join_stake: U128,
    /// yoctoNEAR.
    pub member_storage_deposit: U128,
    pub faucet_amount: U128,
    pub inactive_days: u32,
    pub kick_bounty_bps: u16,
}

fn bps_ok(bps: u16) -> bool {
    u128::from(bps) <= BPS_BASE
}

/// The `new` parameter checks of S3, except `metadata.assert_valid()` (called by `init::new`).
/// Panics with `ERR_BAD_CONFIG` on the first violated check. Never overflows: sums and products
/// are computed in `u128`.
pub fn validate(
    config: &Config,
    total_supply: u128,
    pot_bps: u16,
    faucet_bps: u16,
    initial_holder: &AccountId,
) {
    let bps_fields = [
        config.goal_bps,
        config.emit_bps,
        config.streak_step_bps,
        config.burn_bps,
        config.slash_bps,
        config.kick_bounty_bps,
        pot_bps,
        faucet_bps,
    ];
    require!(bps_fields.into_iter().all(bps_ok), ERR_BAD_CONFIG);
    require!(
        u128::from(pot_bps) + u128::from(faucet_bps) <= BPS_BASE,
        ERR_BAD_CONFIG
    );

    require!(config.warmup_days >= 1, ERR_BAD_CONFIG);
    require!(config.inactive_days >= 1, ERR_BAD_CONFIG);
    require!(config.min_goal >= 1, ERR_BAD_CONFIG);
    require!(
        (1..=MAX_CLOSERS_K).contains(&config.closers_k),
        ERR_BAD_CONFIG
    );
    require!(
        (MIN_DAY_LENGTH_S..=MAX_DAY_LENGTH_S).contains(&config.day_length_s),
        ERR_BAD_CONFIG
    );
    require!(config.jackpot_mult <= MAX_JACKPOT_MULT, ERR_BAD_CONFIG);
    require!(config.join_stake.0 > 0, ERR_BAD_CONFIG);

    // Guarantees budget ≤ pot (S3, S8).
    let max_mult_bps =
        BPS_BASE + u128::from(config.streak_cap) * u128::from(config.streak_step_bps);
    require!(
        u128::from(config.emit_bps) * max_mult_bps <= BUDGET_DENOM,
        ERR_BAD_CONFIG
    );

    require!(
        total_supply > 0 && total_supply <= u128::MAX / BUDGET_DENOM,
        ERR_BAD_CONFIG
    );

    let min_storage_deposit =
        u128::from(MAX_MEMBER_BYTES) * env::storage_byte_cost().as_yoctonear();
    require!(
        config.member_storage_deposit.0 >= min_storage_deposit,
        ERR_BAD_CONFIG
    );

    require!(*initial_holder != env::current_account_id(), ERR_BAD_CONFIG);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{alice, context, contract_id, owner, params};
    use near_sdk::NearToken;

    const E19: u128 = 10_000_000_000_000_000_000;

    /// Arguments of `validate`; `base()` is the mainnet set, which is valid.
    struct Args {
        config: Config,
        total_supply: u128,
        pot_bps: u16,
        faucet_bps: u16,
        initial_holder: AccountId,
    }

    fn base() -> Args {
        let p = params("mainnet");
        Args {
            config: p.config,
            total_supply: p.total_supply.0,
            pot_bps: p.pot_bps,
            faucet_bps: p.faucet_bps,
            initial_holder: owner(),
        }
    }

    fn run(a: &Args) {
        context(&alice(), NearToken::from_yoctonear(0));
        validate(
            &a.config,
            a.total_supply,
            a.pot_bps,
            a.faucet_bps,
            &a.initial_holder,
        );
    }

    /// `validate` on the mainnet set with one change; must panic with ERR_BAD_CONFIG.
    macro_rules! bad_config {
        ($name:ident, |$a:ident| $mutate:expr) => {
            #[test]
            #[should_panic(expected = "ERR_BAD_CONFIG")]
            fn $name() {
                let mut $a = base();
                $mutate;
                run(&$a);
            }
        };
    }

    // S3: every bps field ≤ B.
    bad_config! { t26_bad_config_rejected_goal_bps_over_base, |a| a.config.goal_bps = 10_001 }
    // Also implied by the emit check below: emit_bps > B gives emit_bps × B > 10^8.
    bad_config! { t26_bad_config_rejected_emit_bps_over_base, |a| a.config.emit_bps = 10_001 }
    bad_config! {
        t26_bad_config_rejected_streak_step_bps_over_base,
        |a| a.config.streak_step_bps = 10_001
    }
    bad_config! { t26_bad_config_rejected_burn_bps_over_base, |a| a.config.burn_bps = 10_001 }
    bad_config! { t26_bad_config_rejected_slash_bps_over_base, |a| a.config.slash_bps = 10_001 }
    bad_config! {
        t26_bad_config_rejected_kick_bounty_bps_over_base,
        |a| a.config.kick_bounty_bps = 10_001
    }
    // pot_bps > B and faucet_bps > B are also implied by pot_bps + faucet_bps ≤ B.
    bad_config! { t26_bad_config_rejected_pot_bps_over_base, |a| a.pot_bps = 10_001 }
    bad_config! {
        t26_bad_config_rejected_faucet_bps_over_base,
        |a| { a.pot_bps = 0; a.faucet_bps = 10_001 }
    }
    bad_config! {
        t26_bad_config_rejected_pot_plus_faucet_over_base,
        |a| { a.pot_bps = 5_000; a.faucet_bps = 5_001 }
    }
    // u16::MAX twice must give ERR_BAD_CONFIG, not an arithmetic overflow panic.
    bad_config! {
        t26_bad_config_rejected_bps_u16_max,
        |a| { a.pot_bps = u16::MAX; a.faucet_bps = u16::MAX }
    }

    // S3: lower/upper bounds.
    bad_config! { t26_bad_config_rejected_warmup_days_zero, |a| a.config.warmup_days = 0 }
    bad_config! { t26_bad_config_rejected_inactive_days_zero, |a| a.config.inactive_days = 0 }
    bad_config! { t26_bad_config_rejected_min_goal_zero, |a| a.config.min_goal = 0 }
    bad_config! { t26_bad_config_rejected_closers_k_zero, |a| a.config.closers_k = 0 }
    bad_config! { t26_bad_config_rejected_closers_k_17, |a| a.config.closers_k = 17 }
    bad_config! { t26_bad_config_rejected_day_length_9s, |a| a.config.day_length_s = 9 }
    // 365 days + 1 s.
    bad_config! {
        t26_bad_config_rejected_day_length_too_long,
        |a| a.config.day_length_s = 31_536_001
    }
    bad_config! {
        t26_bad_config_rejected_jackpot_mult_too_big,
        |a| a.config.jackpot_mult = 1_001
    }
    bad_config! { t26_bad_config_rejected_join_stake_zero, |a| a.config.join_stake = U128(0) }

    // S3: emit_bps × (B + streak_cap × streak_step_bps) ≤ 10^8.
    // 2501 × (10 000 + 30 × 1000) = 2501 × 40 000 = 100 040 000 > 10^8.
    bad_config! { t26_bad_config_rejected_emit_budget_2501, |a| a.config.emit_bps = 2_501 }
    // S18 #20: emit_bps = 10 000 with multiplier ×4 (cap 30 × step 1000): 4 × 10^8.
    bad_config! { t26_bad_config_rejected_emit_10000_with_x4, |a| a.config.emit_bps = 10_000 }
    // emit_bps 5 is fine with ×4, but with cap 19 999 × step 1000:
    // 5 × (10 000 + 19 999 000) = 100 045 000 > 10^8.
    bad_config! {
        t26_bad_config_rejected_emit_budget_by_streak_cap,
        |a| a.config.streak_cap = 19_999
    }

    // S3: 0 < total_supply ≤ u128::MAX / 10^8.
    bad_config! { t26_bad_config_rejected_total_supply_zero, |a| a.total_supply = 0 }
    // u128::MAX / 10^8 = 3 402 823 669 209 384 634 633 746 074 317 (floor).
    bad_config! {
        t26_bad_config_rejected_total_supply_over_max,
        |a| a.total_supply = 3_402_823_669_209_384_634_633_746_074_318
    }

    // S3: member_storage_deposit ≥ MAX_MEMBER_BYTES × storage_byte_cost
    // (10^19 yocto/byte in tests).
    bad_config! {
        t26_bad_config_rejected_storage_deposit_below_min,
        |a| a.config.member_storage_deposit = U128(u128::from(MAX_MEMBER_BYTES) * E19 - 1)
    }

    // S3: initial_holder ≠ current_account_id.
    bad_config! {
        t26_bad_config_rejected_initial_holder_is_contract,
        |a| a.initial_holder = contract_id()
    }

    #[test]
    fn t26_storage_byte_cost_assumption() {
        context(&alice(), NearToken::from_yoctonear(0));
        assert_eq!(env::storage_byte_cost().as_yoctonear(), E19);
    }

    /// Every bound of S3 at its edge is accepted (guards against off-by-one: `<` instead of `≤`).
    #[test]
    fn t26_bad_config_boundaries_accepted() {
        let mut a = base();
        a.config.goal_bps = 10_000;
        a.config.streak_step_bps = 10_000; // 5 × (10 000 + 30 × 10 000) = 1 550 000 ≤ 10^8
        a.config.burn_bps = 10_000;
        a.config.slash_bps = 10_000;
        a.config.kick_bounty_bps = 10_000;
        a.config.warmup_days = 1;
        a.config.inactive_days = 1;
        a.config.min_goal = 1;
        a.config.closers_k = 16;
        a.config.day_length_s = 10;
        a.config.join_stake = U128(1);
        a.config.member_storage_deposit = U128(u128::from(MAX_MEMBER_BYTES) * E19);
        a.total_supply = 3_402_823_669_209_384_634_633_746_074_317;
        a.pot_bps = 10_000;
        a.faucet_bps = 0;
        run(&a);

        let mut a = base();
        a.pot_bps = 0;
        a.faucet_bps = 10_000;
        a.config.closers_k = 1;
        a.config.day_length_s = 31_536_000; // 365 × 86 400
        a.config.jackpot_mult = 1_000;
        // 2500 × (10 000 + 30 × 1000) = 10^8 exactly.
        a.config.emit_bps = 2_500;
        run(&a);

        let mut a = base();
        a.config.emit_bps = 10_000;
        a.config.streak_cap = 0; // 10 000 × 10 000 = 10^8 exactly
        a.total_supply = 1;
        run(&a);
    }

    #[test]
    fn t26_bad_config_param_sets_are_valid() {
        for set in ["mainnet", "testnet", "demo"] {
            let p = params(set);
            context(&alice(), NearToken::from_yoctonear(0));
            validate(
                &p.config,
                p.total_supply.0,
                p.pot_bps,
                p.faucet_bps,
                &owner(),
            );
        }
    }

    /// `config/params.json` equals the S2 table, value by value (typed in by hand from the spec).
    #[test]
    fn params_json_matches_spec_s2() {
        let e21 = 1_000_000_000_000_000_000_000u128;
        let total_supply = 1_000_000_000_000_000_000_000_000_000u128; // 10^27
        let mainnet = Config {
            day_length_s: 86_400,
            warmup_days: 2,
            goal_bps: 6000,
            min_goal: 5,
            closers_k: 5,
            jackpot_mult: 10,
            emit_bps: 5,
            streak_step_bps: 1000,
            streak_cap: 30,
            burn_bps: 500,
            slash_bps: 1000,
            join_stake: U128(100 * e21),
            member_storage_deposit: U128(10 * e21),
            faucet_amount: U128(0),
            inactive_days: 5,
            kick_bounty_bps: 2000,
        };
        let testnet = Config {
            day_length_s: 600,
            inactive_days: 6,
            ..mainnet.clone()
        };
        let demo = Config {
            day_length_s: 60,
            warmup_days: 1,
            min_goal: 3,
            emit_bps: 100,
            streak_cap: 10,
            join_stake: U128(e21),
            faucet_amount: U128(5 * e21),
            inactive_days: 3,
            ..mainnet.clone()
        };
        for (set, config, faucet_bps) in [
            ("mainnet", mainnet, 0),
            ("testnet", testnet, 0),
            ("demo", demo, 100),
        ] {
            let p = params(set);
            assert_eq!(p.config, config, "{set}");
            assert_eq!(p.total_supply.0, total_supply, "{set}");
            assert_eq!(p.pot_bps, 5000, "{set}");
            assert_eq!(p.faucet_bps, faucet_bps, "{set}");
        }
    }
}
