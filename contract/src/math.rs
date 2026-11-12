//! Pure formulas, no storage (spec S6, S8, S9, S11). Owner: C2.
//!
//! Integer arithmetic only, all divisions round down unless stated otherwise. Overflow panics
//! (`overflow-checks = true`); the bounds that rule it out under a valid config (S3) are noted per
//! function.

use near_sdk::env;

use crate::config::{BPS_BASE, BUDGET_DENOM};

/// S6: `0` if `active_count < min_goal`,
/// else `max(min_goal, ceil(active_count × goal_bps / B))` in u64.
///
/// With `goal_bps ≤ B` (S3) the result is `≤ active_count` and fits in `u32`.
pub fn goal_for(active_count: u32, min_goal: u32, goal_bps: u16) -> u32 {
    if active_count < min_goal {
        return 0;
    }
    let share = (u64::from(active_count) * u64::from(goal_bps)).div_ceil(BPS_BASE as u64);
    let goal = share.max(u64::from(min_goal));
    u32::try_from(goal).expect("goal ≤ active_count when goal_bps ≤ B (S3)")
}

/// `B + min(streak, cap) × step_bps` (S8).
pub fn mult_bps(streak: u32, cap: u32, step_bps: u16) -> u128 {
    BPS_BASE + u128::from(streak.min(cap)) * u128::from(step_bps)
}

/// `pot × emit_bps × mult_bps / 10^8` (S8).
///
/// No overflow and `budget ≤ pot` when `pot ≤ u128::MAX / 10^8` and
/// `emit_bps × mult_bps ≤ 10^8` (S3).
pub fn budget(pot: u128, emit_bps: u16, mult_bps: u128) -> u128 {
    pot * u128::from(emit_bps) * mult_bps / BUDGET_DENOM
}

/// `budget / (count + jackpot_mult)` (S8), the denominator in u128.
///
/// `0` when the denominator is `0` (`count == 0 && jackpot_mult == 0`): nothing to share.
pub fn per_share(budget: u128, count: u32, jackpot_mult: u32) -> u128 {
    let shares = u128::from(count) + u128::from(jackpot_mult);
    budget.checked_div(shares).unwrap_or(0)
}

/// `(active_stake − checked_stake) × slash_bps / B`, floor (S8).
/// The `min(…, active_stake)` of R11 is the caller's.
pub fn aggregate_slash(active_stake: u128, checked_stake: u128, slash_bps: u16) -> u128 {
    (active_stake - checked_stake) * u128::from(slash_bps) / BPS_BASE
}

/// `n` times `stake × (B − b) / B`, early exit at 0 (S9, R1).
///
/// The kept part rounds down, so the member loses the ceiling and the sum of personal stakes
/// never exceeds the aggregate (`aggregate_slash`, floor). Every step with `b > 0` strictly
/// decreases a positive stake, so the loop ends after at most `n` steps or when the stake hits 0;
/// `b == 0` changes nothing and returns at once.
pub fn stake_after_slashes(stake: u128, n: u32, slash_bps: u16) -> u128 {
    if slash_bps == 0 {
        return stake;
    }
    let keep_bps = BPS_BASE - u128::from(slash_bps);
    let mut stake = stake;
    for _ in 0..n {
        if stake == 0 {
            break;
        }
        stake = stake * keep_bps / BPS_BASE;
    }
    stake
}

/// `stake × b / B` (S10).
pub fn leave_fee(stake: u128, slash_bps: u16) -> u128 {
    stake * u128::from(slash_bps) / BPS_BASE
}

/// `u64::from_le_bytes(sha256(seed ‖ day.to_le_bytes() ‖ b"lastcall")[0..8]) % len` (S11).
///
/// Panics on `len == 0` (remainder by zero): the caller must not draw from an empty list.
pub fn hero_index(seed: &[u8; 32], day: u32, len: usize) -> usize {
    let mut preimage = [0u8; 32 + 4 + 8];
    preimage[..32].copy_from_slice(seed);
    preimage[32..36].copy_from_slice(&day.to_le_bytes());
    preimage[36..].copy_from_slice(b"lastcall");
    let hash = env::sha256_array(preimage);
    let mut prefix = [0u8; 8];
    prefix.copy_from_slice(&hash[..8]);
    // usize is at most 64 bits on every target; the remainder is < len, so it fits back.
    (u64::from_le_bytes(prefix) % len as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `u128::MAX / 10^8`: the largest valid `total_supply` (S3). Value from
    /// `python3 -c 'print((2**128 - 1) // 10**8)'`.
    const MAX_SUPPLY: u128 = 3_402_823_669_209_384_634_633_746_074_317;
    /// mainnet / testnet `join_stake` (S2).
    const STAKE_E23: u128 = 100_000_000_000_000_000_000_000;
    /// demo `join_stake` (S2).
    const STAKE_E21: u128 = 1_000_000_000_000_000_000_000;

    /// xorshift64 (Marsaglia 13/7/17): deterministic, no crate.
    struct Xorshift(u64);

    impl Xorshift {
        fn new(seed: u64) -> Self {
            Self(seed.max(1))
        }

        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        /// `true` with probability `percent / 100`.
        fn chance(&mut self, percent: u64) -> bool {
            self.next() % 100 < percent
        }
    }

    // ---- goal_for (S6) ----

    #[test]
    fn goal_for_zero_below_min_goal() {
        assert_eq!(goal_for(0, 5, 6000), 0);
        assert_eq!(goal_for(4, 5, 6000), 0);
        assert_eq!(goal_for(4, 5, 10_000), 0);
        assert_eq!(goal_for(0, 1, 10_000), 0);
    }

    #[test]
    fn goal_for_exactly_min_goal() {
        // ceil(5 × 0.6) = 3 < 5 → min_goal.
        assert_eq!(goal_for(5, 5, 6000), 5);
        assert_eq!(goal_for(3, 3, 6000), 3);
        assert_eq!(goal_for(1, 1, 1), 1);
    }

    #[test]
    fn goal_for_rounds_up() {
        assert_eq!(goal_for(10, 5, 6000), 6); // 6.0
        assert_eq!(goal_for(11, 5, 6000), 7); // 6.6
        assert_eq!(goal_for(9, 5, 6000), 6); // 5.4
        assert_eq!(goal_for(20_000, 1, 1), 2); // 2.0, no extra unit
        assert_eq!(goal_for(20_001, 1, 1), 3); // 2.0001
        assert_eq!(goal_for(100, 5, 6001), 61); // 60.01
    }

    #[test]
    fn goal_for_goal_bps_bounds() {
        assert_eq!(goal_for(100, 5, 0), 5);
        assert_eq!(goal_for(5, 5, 0), 5);
        assert_eq!(goal_for(100, 5, 10_000), 100);
        assert_eq!(goal_for(7, 7, 10_000), 7);
    }

    // ---- mult_bps / budget / per_share (S8) ----

    #[test]
    fn mult_bps_caps_at_streak_cap() {
        assert_eq!(mult_bps(0, 30, 1000), 10_000);
        assert_eq!(mult_bps(1, 30, 1000), 11_000);
        assert_eq!(mult_bps(29, 30, 1000), 39_000);
        assert_eq!(mult_bps(30, 30, 1000), 40_000);
        assert_eq!(mult_bps(31, 30, 1000), 40_000);
        assert_eq!(mult_bps(u32::MAX, 30, 1000), 40_000);
        assert_eq!(mult_bps(10, 0, 1000), 10_000);
        assert_eq!(mult_bps(10, 30, 0), 10_000);
    }

    #[test]
    fn budget_formula_and_floor() {
        // mainnet pot 5·10^26, emit 5 bps, streak 1: 5·10^26 × 5 × 11 000 / 10^8 = 2.75·10^23.
        assert_eq!(
            budget(500_000_000_000_000_000_000_000_000, 5, 11_000),
            275_000_000_000_000_000_000_000
        );
        assert_eq!(budget(10_000, 1, 10_000), 1);
        assert_eq!(budget(9_999, 1, 10_000), 0); // 0.9999
        assert_eq!(budget(19_999, 1, 10_000), 1); // 1.9999
        assert_eq!(budget(0, 10_000, 10_000), 0);
        assert_eq!(budget(123, 0, 40_000), 0);
    }

    #[test]
    fn per_share_formula_and_zero_denominator() {
        assert_eq!(per_share(1000, 5, 10), 66); // 1000 / 15 = 66.6
        assert_eq!(per_share(1000, 3, 0), 333);
        assert_eq!(per_share(100, 0, 10), 10);
        assert_eq!(per_share(14, 5, 10), 0);
        assert_eq!(per_share(0, 5, 10), 0);
        // count = 0 and jackpot_mult = 0: no shares, no panic.
        assert_eq!(per_share(100, 0, 0), 0);
        assert_eq!(per_share(0, 0, 0), 0);
    }

    // ---- aggregate_slash (S8), leave_fee (S10) ----

    #[test]
    fn aggregate_slash_formula_and_floor() {
        // (10^24 − 4·10^23) × 1000 / 10^4 = 6·10^22.
        assert_eq!(
            aggregate_slash(
                1_000_000_000_000_000_000_000_000,
                400_000_000_000_000_000_000_000,
                1000
            ),
            60_000_000_000_000_000_000_000
        );
        assert_eq!(aggregate_slash(19, 0, 1000), 1); // 1.9
        assert_eq!(aggregate_slash(29, 10, 1000), 1); // 19 → 1.9
        assert_eq!(aggregate_slash(9, 0, 1000), 0);
        assert_eq!(aggregate_slash(500, 500, 1000), 0);
        assert_eq!(aggregate_slash(500, 0, 0), 0);
        assert_eq!(aggregate_slash(500, 100, 10_000), 400);
    }

    #[test]
    #[should_panic]
    fn aggregate_slash_does_not_saturate_when_checked_exceeds_active() {
        // I12 guarantees checked ≤ active; a violation panics instead of slashing 0.
        aggregate_slash(1, 2, 1000);
    }

    #[test]
    fn leave_fee_formula_and_floor() {
        assert_eq!(leave_fee(STAKE_E23, 1000), 10_000_000_000_000_000_000_000);
        assert_eq!(leave_fee(19, 1000), 1);
        assert_eq!(leave_fee(9, 1000), 0);
        assert_eq!(leave_fee(STAKE_E23, 0), 0);
        assert_eq!(leave_fee(STAKE_E23, 10_000), STAKE_E23);
    }

    // ---- stake_after_slashes (S9, R1) ----

    #[test]
    fn stake_after_slashes_member_loses_the_ceiling() {
        assert_eq!(
            stake_after_slashes(STAKE_E23, 1, 1000),
            90_000_000_000_000_000_000_000
        );
        assert_eq!(
            stake_after_slashes(STAKE_E23, 3, 1000),
            72_900_000_000_000_000_000_000
        );
        // 19 × 0.9 = 17.1 → 17 (the old `19 − 19 × 1000 / 10^4` gives 18).
        assert_eq!(stake_after_slashes(19, 1, 1000), 17);
        // 19 → 17 → 15 (15.3) → 13 (13.5).
        assert_eq!(stake_after_slashes(19, 3, 1000), 13);
        assert_eq!(stake_after_slashes(1, 1, 1), 0); // 0.9999
        assert_eq!(stake_after_slashes(10_000, 1, 1), 9_999);
    }

    #[test]
    fn stake_after_slashes_trivial_cases() {
        assert_eq!(stake_after_slashes(STAKE_E23, 0, 1000), STAKE_E23);
        assert_eq!(stake_after_slashes(0, 10, 1000), 0);
        assert_eq!(stake_after_slashes(STAKE_E23, 1, 10_000), 0);
        assert_eq!(stake_after_slashes(STAKE_E23, 5, 0), STAKE_E23);
    }

    #[test]
    fn stake_after_slashes_exits_early() {
        // Would run 2^32 − 1 iterations without the early exits.
        assert_eq!(stake_after_slashes(1, u32::MAX, 1000), 0);
        assert_eq!(stake_after_slashes(STAKE_E23, u32::MAX, 1000), 0);
        assert_eq!(stake_after_slashes(STAKE_E23, u32::MAX, 0), STAKE_E23);
    }

    #[test]
    fn stake_after_slashes_composes() {
        // resolve applies the slashes lazily in several calls: n + m at once == n, then m.
        let mut rng = Xorshift::new(0xC2);
        for _ in 0..500 {
            let stake = u128::from(rng.next()) * u128::from(rng.next() % 1_000_000);
            let b = (rng.next() % 10_001) as u16;
            let n = (rng.next() % 40) as u32;
            let m = (rng.next() % 40) as u32;
            assert_eq!(
                stake_after_slashes(stake, n + m, b),
                stake_after_slashes(stake_after_slashes(stake, n, b), m, b),
                "stake {stake}, b {b}, n {n}, m {m}"
            );
        }
    }

    /// The R1 model of the patch (§4.4): 40 members with `join_stake = 10^23`, `b = 1000`,
    /// 120 days, 60% failed days, every member skips a day with probability 50%. Personal stakes
    /// are applied eagerly with `personal_slash`; the aggregate loses `aggregate_slash` on every
    /// failed day. Returns `(runs where Σ personal > aggregate at some point, max dust)`.
    fn r1_model(runs: u64, personal_slash: fn(u128, u16) -> u128) -> (u32, u128) {
        const MEMBERS: usize = 40;
        const DAYS: u32 = 120;
        const B: u16 = 1000;
        let mut violating_runs = 0;
        let mut max_dust = 0;
        for run in 0..runs {
            let mut rng = Xorshift::new(0x9E37_79B9_7F4A_7C15 ^ (run + 1));
            let mut stakes = [STAKE_E23; MEMBERS];
            let mut aggregate = STAKE_E23 * MEMBERS as u128;
            for _ in 0..DAYS {
                let failed = rng.chance(60);
                let checked: Vec<bool> = (0..MEMBERS).map(|_| rng.next() & 1 == 0).collect();
                if !failed {
                    continue;
                }
                let checked_stake: u128 = (0..MEMBERS)
                    .filter(|&i| checked[i])
                    .map(|i| stakes[i])
                    .sum();
                aggregate -= aggregate_slash(aggregate, checked_stake, B);
                for i in (0..MEMBERS).filter(|&i| !checked[i]) {
                    stakes[i] = personal_slash(stakes[i], B);
                }
                let personal: u128 = stakes.iter().sum();
                if personal > aggregate {
                    // The next day's `aggregate − checked_stake` could underflow: stop the run.
                    violating_runs += 1;
                    break;
                }
                max_dust = max_dust.max(aggregate - personal);
            }
        }
        (violating_runs, max_dust)
    }

    #[test]
    fn t09b_r1_model_sum_of_personal_stakes_never_exceeds_aggregate() {
        let (violating_runs, max_dust) = r1_model(200, |stake, b| stake_after_slashes(stake, 1, b));
        assert_eq!(violating_runs, 0, "Σ personal > aggregate (S17 I3)");
        // Each failed day adds less than (skipping members + 1) yocto of dust: < 120 × 41.
        assert!(max_dust < 120 * 41, "dust {max_dust}");
    }

    #[test]
    fn t09b_r1_model_old_formula_breaks_the_inequality() {
        // `stake − stake × b / B`: the member loses the floor, so the model must catch it.
        let (violating_runs, _) = r1_model(200, |stake, b| stake - stake * u128::from(b) / 10_000);
        assert!(
            violating_runs >= 1,
            "the model does not tell the formulas apart"
        );
    }

    #[test]
    fn t09b_precision_bound_stake_1e23() {
        // 10^23 × 0.9^k = 9^k × 10^(23 − k): the first 23 slashes leave no remainder.
        let mut before = STAKE_E23;
        for k in 1..=23u32 {
            let after = stake_after_slashes(STAKE_E23, k, 1000);
            assert_eq!(before * 9000 % 10_000, 0, "slash {k} has a remainder");
            assert_eq!(after, 9u128.pow(k) * 10u128.pow(23 - k), "slash {k}");
            before = after;
        }
        // 9^23 = 8862938119652501095929; 9^24 = 79766443076872509863361 (python3 -c 'print(9**24)').
        assert_eq!(before, 8_862_938_119_652_501_095_929);
        assert_ne!(before * 9000 % 10_000, 0, "slash 24 must have a remainder");
        // 24th: floor(9^24 / 10); the old formula would keep one more yocto (…337).
        assert_eq!(
            stake_after_slashes(STAKE_E23, 24, 1000),
            7_976_644_307_687_250_986_336
        );
        assert_eq!(
            before - before * 1000 / 10_000,
            7_976_644_307_687_250_986_337
        );
    }

    #[test]
    fn t09b_precision_bound_stake_1e21() {
        let mut before = STAKE_E21;
        for k in 1..=21u32 {
            let after = stake_after_slashes(STAKE_E21, k, 1000);
            assert_eq!(before * 9000 % 10_000, 0, "slash {k} has a remainder");
            assert_eq!(after, 9u128.pow(k) * 10u128.pow(21 - k), "slash {k}");
            before = after;
        }
        // 9^21 = 109418989131512359209; 9^22 = 984770902183611232881.
        assert_eq!(before, 109_418_989_131_512_359_209);
        assert_ne!(before * 9000 % 10_000, 0, "slash 22 must have a remainder");
        assert_eq!(
            stake_after_slashes(STAKE_E21, 22, 1000),
            98_477_090_218_361_123_288
        );
    }

    // ---- hero_index (S11) ----

    /// Seed bytes 0, 1, …, 31.
    fn seed_0_to_31() -> [u8; 32] {
        core::array::from_fn(|i| i as u8)
    }

    // Expected indices were computed independently with Python's hashlib:
    //   import hashlib
    //   def h(seed, day):
    //       d = hashlib.sha256(seed + day.to_bytes(4, 'little') + b"lastcall").digest()
    //       return int.from_bytes(d[:8], 'little')
    //   seed = bytes(range(32)); [h(seed, d) % 5 for d in range(10)]  # etc.

    #[test]
    fn t14_hero_index_deterministic_for_fixed_seed() {
        let seed = seed_0_to_31();
        assert_eq!(hero_index(&seed, 7, 5), 2);
        assert_eq!(hero_index(&seed, 7, 5), 2);
        let by_day: Vec<usize> = (0..10).map(|day| hero_index(&seed, day, 5)).collect();
        assert_eq!(by_day, [4, 2, 3, 0, 1, 3, 0, 2, 2, 3]);
        assert_eq!(hero_index(&seed, u32::MAX, 7), 4);
        assert_eq!(hero_index(&[0; 32], 0, 3), 1);
        assert_eq!(hero_index(&seed, 7, 1), 0);
    }

    #[test]
    fn t14_hero_index_takes_little_endian_u64_prefix() {
        // len = 2^32 − 1 keeps most of the u64, so byte order and the 8-byte prefix matter.
        let seed = seed_0_to_31();
        let len = u32::MAX as usize;
        let by_day: Vec<usize> = (0..5).map(|day| hero_index(&seed, day, len)).collect();
        assert_eq!(
            by_day,
            [
                4_062_903_269,
                1_017_682_967,
                2_223_164_513,
                1_369_204_510,
                330_945_381
            ]
        );
    }

    #[test]
    fn t14_hero_index_differs_across_days() {
        let seed = seed_0_to_31();
        let by_day: Vec<usize> = (0..10).map(|day| hero_index(&seed, day, 16)).collect();
        assert_eq!(by_day, [12, 14, 11, 6, 10, 6, 3, 8, 15, 14]);
        let mut seen = [false; 5];
        for day in 0..100 {
            seen[hero_index(&seed, day, 5)] = true;
        }
        assert_eq!(seen, [true; 5], "every slot is drawn on some day");
    }

    #[test]
    fn t14_hero_index_uniform_over_1000_seeds() {
        let mut rng = Xorshift::new(0x14);
        let mut slots = [0u32; 5];
        for _ in 0..1000 {
            let mut seed = [0u8; 32];
            for chunk in seed.chunks_mut(8) {
                chunk.copy_from_slice(&rng.next().to_le_bytes());
            }
            slots[hero_index(&seed, 42, 5)] += 1;
        }
        // 200 ± 30% per slot.
        assert!(slots.iter().all(|&n| (140..=260).contains(&n)), "{slots:?}");
    }

    #[test]
    #[should_panic]
    fn hero_index_panics_on_empty_list() {
        hero_index(&seed_0_to_31(), 0, 0);
    }

    // ---- S18 20: the largest valid configuration ----

    #[test]
    fn t20_max_supply_constant() {
        assert_eq!(MAX_SUPPLY, u128::MAX / BUDGET_DENOM);
    }

    #[test]
    fn t20_budget_on_max_valid_config_does_not_overflow() {
        // emit_bps × (B + streak_cap × streak_step_bps) = 10^8 exactly (S3): budget == pot.
        let configs: [(u16, u32, u16); 6] = [
            (10_000, 0, 0),
            (10_000, 30, 0),
            (5_000, 1, 10_000),
            (2_500, 3, 10_000),
            (4, 2_499, 10_000),
            (1, 9_999, 10_000),
        ];
        for (emit_bps, cap, step) in configs {
            let mult = mult_bps(u32::MAX, cap, step);
            assert_eq!(u128::from(emit_bps) * mult, BUDGET_DENOM, "precondition");
            assert_eq!(
                budget(MAX_SUPPLY, emit_bps, mult),
                MAX_SUPPLY,
                "{emit_bps}/{cap}/{step}"
            );
        }
        // mainnet emission at the cap on the largest pot: TS × 5 × 40 000 / 10^8.
        assert_eq!(
            budget(MAX_SUPPLY, 5, mult_bps(30, 30, 1000)),
            6_805_647_338_418_769_269_267_492_148
        );
    }

    #[test]
    fn t20_per_share_and_mult_on_max_values() {
        // count + jackpot_mult overflows u32; the denominator is u128.
        assert_eq!(
            per_share(MAX_SUPPLY, u32::MAX, 1000),
            792_281_440_859_712_943_383
        );
        assert_eq!(per_share(MAX_SUPPLY, 1, 0), MAX_SUPPLY);
        // 10 000 + (2^32 − 1) × 10 000.
        assert_eq!(mult_bps(u32::MAX, u32::MAX, 10_000), 42_949_672_960_000);
    }

    #[test]
    fn t20_goal_for_on_max_active_count() {
        // active_count × goal_bps overflows u32; computed in u64.
        assert_eq!(goal_for(u32::MAX, 1, 10_000), u32::MAX);
        assert_eq!(goal_for(u32::MAX, 1, 9_999), 4_294_537_799);
        assert_eq!(goal_for(u32::MAX, 5, 6_000), 2_576_980_377);
        assert_eq!(goal_for(u32::MAX, u32::MAX, 0), u32::MAX);
    }

    #[test]
    fn t20_stake_math_on_max_supply() {
        assert_eq!(
            stake_after_slashes(MAX_SUPPLY, 1, 1),
            3_402_483_386_842_463_696_170_282_699_709
        );
        assert_eq!(
            stake_after_slashes(MAX_SUPPLY, 1, 1000),
            3_062_541_302_288_446_171_170_371_466_885
        );
        assert_eq!(
            stake_after_slashes(MAX_SUPPLY, 3, 1000),
            2_480_658_454_853_641_398_648_000_888_176
        );
        assert_eq!(stake_after_slashes(MAX_SUPPLY, 1, 10_000), 0);
        // Reaches 0 after 651 slashes of 10%.
        assert_eq!(stake_after_slashes(MAX_SUPPLY, 650, 1000), 1);
        assert_eq!(stake_after_slashes(MAX_SUPPLY, 651, 1000), 0);
        assert_eq!(stake_after_slashes(MAX_SUPPLY, u32::MAX, 1000), 0);

        assert_eq!(leave_fee(MAX_SUPPLY, 10_000), MAX_SUPPLY);
        assert_eq!(
            leave_fee(MAX_SUPPLY, 1),
            340_282_366_920_938_463_463_374_607
        );
        assert_eq!(
            leave_fee(MAX_SUPPLY, 1000),
            340_282_366_920_938_463_463_374_607_431
        );

        assert_eq!(aggregate_slash(MAX_SUPPLY, 0, 10_000), MAX_SUPPLY);
        assert_eq!(
            aggregate_slash(MAX_SUPPLY, 0, 1000),
            340_282_366_920_938_463_463_374_607_431
        );
    }
}
