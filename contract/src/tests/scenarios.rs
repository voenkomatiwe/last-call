//! End-to-end scenarios (S18 8, 9b, 18, 20, 24, 29, happy path, failures and exits, heroes).
//!
//! Every call goes through `World`: the reference model and all invariants are checked after each
//! one. The numbers asserted here are computed independently with Python big integers from the
//! spec formulas (noted per test), so a bug shared by the contract and the model still shows:
//! success `ps = ⌊⌊pot × emit_bps × (B + min(streak, cap) × step) / 10^8⌋ / (count + jackpot_mult)⌋`,
//! `pot −= ps × (shares + jackpot_mult)`; fail `pot −= ⌊pot × burn_bps / B⌋`, aggregate slash
//! `⌊(open.active_stake − open.checked_stake) × b / B⌋`, personal stake `⌊s × (B − b) / B⌋`.

use near_sdk::AccountId;
use near_sdk::json_types::U128;

use super::*;
use crate::test_utils::{params, user};

/// `join_stake` of the demo set: 10^21.
const DEMO_STAKE: u128 = 1_000_000_000_000_000_000_000;
/// 10^23: `join_stake` of mainnet/testnet.
const BIG_STAKE: u128 = 100_000_000_000_000_000_000_000;
/// Pot after `new` of every set: 10^27 × 5000 / 10^4.
const POT0: u128 = 500_000_000_000_000_000_000_000_000;

fn users(n: u32) -> Vec<AccountId> {
    (0..n).map(user).collect()
}

fn stranger() -> AccountId {
    "stranger.near".parse().expect("account id")
}

/// Runs every pending `pick_hero` promise (in creation order) with a seed derived from the day.
fn run_heroes(w: &mut World, promises: &mut Vec<u32>) {
    for day in std::mem::take(promises) {
        let mut seed = [0u8; 32];
        seed[..4].copy_from_slice(&day.to_le_bytes());
        w.pick_hero(day, seed);
    }
}

/// Happy path, demo set: 7 members join on day 0 and check in every day 1..=12 in rotating order
/// (goal max(3, ⌈7 × 0.6⌉) = 5). Each day succeeds: streak 1..12, the multiplier stops at the cap
/// (10 × 10% → ×2.0) from day 10. The hero of each day is drawn 0–3 calls later.
///
/// Python: pot = 5·10^26; for d in 1..=12: mult = 10^4 + min(d, 10) × 10^3;
/// ps = ⌊pot × 100 × mult / 10^8⌋ // 17; pot −= 17 × ps → Σ ps = 5 250 928 798 774 590 841 019 169,
/// pot after day 12 = 410 734 210 420 831 955 702 674 127.
#[test]
fn happy_path_12_days() {
    const PS: [u128; 12] = [
        323_529_411_764_705_882_352_941,
        349_058_823_529_411_764_705_882,
        373_609_294_117_647_058_823_529,
        397_117_940_470_588_235_294_117,
        419_526_738_540_000_000_000_000,
        440_782_759_959_360_000_000_000,
        460_838_375_537_510_880_000_000,
        479_651_424_515_336_324_160_000,
        497_185_348_811_508_063_120_960,
        513_409_291_772_725_694_654_380,
        503_141_105_937_271_180_761_293,
        493_078_283_818_525_757_146_067,
    ];
    const TOTAL: u128 = 5_250_928_798_774_590_841_019_169;
    const POT12: u128 = 410_734_210_420_831_955_702_674_127;
    assert_eq!(PS.iter().sum::<u128>(), TOTAL);

    let mut w = World::new("demo");
    let members = users(7);
    for a in &members {
        w.fund_and_join(a, None).unwrap();
    }
    let mut promises = Vec::new();
    for day in 1..=12u32 {
        w.goto(day, 5);
        for i in 0..7 {
            let a = &members[(i + day as usize) % 7];
            let r = w.check_in(a).unwrap();
            assert_eq!((r.day, r.n, r.goal), (day, i as u32 + 1, 5));
            assert_eq!(r.in_closers, i < 5, "the first five are the closers");
            promises.extend(w.new_pick_hero_promises());
            // The hero of yesterday is drawn a few calls after the settle.
            if i as u32 == day % 4 {
                run_heroes(&mut w, &mut promises);
            }
        }
        if day > 1 {
            let s = &w.m.days[day as usize - 1];
            assert_eq!(s.outcome, Outcome::Success);
            assert_eq!(s.per_share.0, PS[day as usize - 2]);
            assert_eq!(s.streak_after, day - 1);
        }
    }
    w.goto(13, 0);
    for a in &members {
        assert_eq!(w.claim(a).unwrap(), TOTAL, "Σ of the 12 shares");
        promises.extend(w.new_pick_hero_promises());
    }
    run_heroes(&mut w, &mut promises);
    assert_eq!((w.c.streak, w.c.longest_streak), (12, 12));
    assert_eq!(w.c.pot, POT12);
    assert_eq!(w.c.reserved, 0);
    assert_eq!(w.c.total_rewarded, 7 * TOTAL);
    assert_eq!(w.c.total_jackpots, 10 * TOTAL);
    assert_eq!(w.c.jackpot_pending, 0);
    let heroes: u32 = members
        .iter()
        .map(|a| w.member(a).unwrap().hero_count)
        .sum();
    assert_eq!(heroes, 12);
    // Everything paid out went to the members: 7 shares + 10 jackpot shares a day.
    let paid: u128 = members.iter().map(|a| w.balance(a)).sum();
    assert_eq!(paid, 17 * TOTAL);
    for a in &members {
        let m = w.member(a).unwrap();
        assert_eq!(
            (m.checkins, m.personal_streak, m.best_personal_streak),
            (12, 12, 12)
        );
        assert_eq!(m.stake, DEMO_STAKE);
    }
    assert_eq!(w.c.stake_pool, 7 * DEMO_STAKE);
    assert_eq!(w.c.pot + 17 * TOTAL, POT0);
}

/// Failures and exits, demo set, six members u0..u5 (active from day 1):
/// - day 1: u0..u3 check in → Success (goal 4);
/// - day 2: u0, u1, u2 check in, u2 leaves right after (R4, no fee), u4 leaves without checking
///   in (fee 10%) → Fail: pot −5%, slash ⌊(4S − 2S) × 10%⌋ = 2·10^20;
/// - day 3: u0, u1, u3 check in → Success (goal 3: four active);
/// - day 4: u0 kicks u5 (never checked in, kickable from day 1 + 3): fee 9·10^19 of the slashed
///   9·10^20, bounty 1.8·10^19 to u0; u4 joins again; u0, u1, u3 check in → Success;
/// - day 5: u0, u1, u3, u4 check in → Success; day 6: everyone claims and leaves.
///
/// Python, day by day with the formulas of the module header: ps1 = ⌊5.5·10^24 / 14⌋, burn2 =
/// ⌊pot1 × 5%⌋, ps3 = ⌊⌊pot2 × 1.1%⌋ / 13⌋, ps4 = ⌊⌊pot3 × 1.2%⌋ / 13⌋, ps5 = ⌊⌊pot4 × 1.3%⌋ / 14⌋.
#[test]
fn failures_and_exits() {
    const PS1: u128 = 392_857_142_857_142_857_142_857;
    const BURN2: u128 = 24_725_000_000_000_000_000_000_000;
    const PS3: u128 = 397_501_923_076_923_076_923_076;
    const PS4: u128 = 428_868_438_461_538_461_538_461;
    const PS5: u128 = 426_244_172_064_285_714_285_714;
    const POT5: u128 = 453_064_766_891_100_000_000_000_025;
    let u = users(6);
    let mut w = World::new("demo");
    for a in &u {
        w.fund_and_join(a, None).unwrap();
    }
    w.goto(1, 0);
    for a in &u[..4] {
        w.check_in(a).unwrap();
    }

    w.goto(2, 0);
    for a in &u[..3] {
        w.check_in(a).unwrap();
    }
    assert_eq!(w.m.days[1].per_share.0, PS1);
    // u2: today's check-in, no fee; gets the stake and the day-1 share.
    let before = w.balance(&u[2]);
    assert_eq!(w.leave(&u[2]).unwrap(), DEMO_STAKE);
    assert_eq!(w.balance(&u[2]) - before, DEMO_STAKE + PS1);
    assert_eq!(w.c.open.forfeited, 1);
    // u4: no check-in today: fee 10^20 burned.
    let burned = w.c.total_burned;
    assert_eq!(w.leave(&u[4]).unwrap(), 900_000_000_000_000_000_000);
    assert_eq!(w.c.total_burned - burned, 100_000_000_000_000_000_000);
    assert_eq!(w.c.open.active_stake, 4 * DEMO_STAKE);
    assert_eq!(w.c.open.checked_stake, 2 * DEMO_STAKE);

    w.goto(3, 0);
    for i in [0, 1, 3] {
        w.check_in(&u[i]).unwrap();
    }
    let d2 = &w.m.days[2];
    assert_eq!((d2.outcome, d2.count, d2.goal), (Outcome::Fail, 3, 4));
    assert_eq!(d2.pot_burned.0, BURN2);
    assert_eq!(d2.stake_slashed.0, 200_000_000_000_000_000_000);
    // u3 and u5 did not check in on day 2.
    assert_eq!(w.member(&u[3]).unwrap().stake, 900_000_000_000_000_000_000);
    assert_eq!(w.member(&u[5]).unwrap().stake, 900_000_000_000_000_000_000);
    assert_eq!(w.member(&u[0]).unwrap().stake, DEMO_STAKE);
    assert_eq!(w.c.open.goal, 3);

    w.goto(4, 0);
    let before = w.balance(&u[0]);
    assert_eq!(w.kick(&u[0], &u[5]).unwrap(), 18_000_000_000_000_000_000);
    assert_eq!(w.balance(&u[5]), 810_000_000_000_000_000_000);
    assert_eq!(w.m.days[3].per_share.0, PS3);
    // u4 has 9·10^20 left: top up and join again (new warmup).
    w.fund(&u[4], 100_000_000_000_000_000_000);
    w.join(&u[4], None).unwrap();
    assert_eq!(w.member(&u[4]).unwrap().activation_day, 5);
    for i in [0, 1, 3] {
        w.check_in(&u[i]).unwrap();
    }
    assert_eq!(w.balance(&u[0]) - before, 18_000_000_000_000_000_000);

    w.goto(5, 0);
    for i in [0, 1, 3, 4] {
        w.check_in(&u[i]).unwrap();
    }
    assert_eq!(w.m.days[4].per_share.0, PS4);

    w.goto(6, 0);
    for i in [0, 1, 3] {
        assert_eq!(w.claim(&u[i]).unwrap(), PS1 + PS3 + PS4 + PS5);
    }
    assert_eq!(w.claim(&u[4]).unwrap(), PS5);
    assert_eq!(w.c.pot, POT5);
    assert_eq!(w.c.reserved, 0);
    assert_eq!(w.leave(&u[3]).unwrap(), 810_000_000_000_000_000_000);
    for i in [0, 1, 4] {
        assert_eq!(w.leave(&u[i]).unwrap(), 900_000_000_000_000_000_000);
    }
    assert_eq!(
        (w.c.stake_pool, w.c.active_stake, w.c.members_total),
        (0, 0, 0)
    );
}

/// S18 8 end to end, demo set, four members A, B, C, D: day 1 all check in (Success); A is away
/// on days 2..11 while B, C, D keep the days successful, except day 5 when only B checks in
/// (Fail). B is not slashed for day 5, C, D and A are. A comes back on day 12 and gets exactly
/// the share of day 1, B gets every share.
///
/// Python, day by day (streak restarts after day 5): ps1 = 392 857 142 857 142 857 142 857,
/// Σ for B (days 1–4, 6–11) = 4 578 566 907 829 685 508 465 217.
#[test]
fn t08_end_to_end_checked_not_slashed_share_after_10_days() {
    const PS1: u128 = 392_857_142_857_142_857_142_857;
    const B_TOTAL: u128 = 4_578_566_907_829_685_508_465_217;
    const POT11: u128 = 416_312_591_204_756_945_532_809_322;
    let [a, b, c, d] = [user(0), user(1), user(2), user(3)];
    let mut w = World::new("demo");
    for x in [&a, &b, &c, &d] {
        w.fund_and_join(x, None).unwrap();
    }
    w.goto(1, 0);
    for x in [&a, &b, &c, &d] {
        w.check_in(x).unwrap();
    }
    for day in 2..=11 {
        w.goto(day, 0);
        let who: &[&AccountId] = if day == 5 { &[&b] } else { &[&b, &c, &d] };
        for x in who {
            w.check_in(x).unwrap();
        }
    }
    w.goto(12, 0);
    assert_eq!(w.claim(&a).unwrap(), PS1);
    assert_eq!(w.member(&a).unwrap().stake, 900_000_000_000_000_000_000);
    assert_eq!(w.member(&b).unwrap().stake, DEMO_STAKE);
    assert_eq!(w.member(&c).unwrap().stake, 900_000_000_000_000_000_000);
    assert_eq!(w.claim(&b).unwrap(), B_TOTAL);
    assert_eq!(w.m.days[5].outcome, Outcome::Fail);
    assert_eq!(w.c.pot, POT11);
    assert_eq!(w.c.streak, 6);
}

/// S18 9b end to end: demo set with `join_stake = 10^23`; X never checks in through 30 failed
/// days (R1 dust from the 24th), Y checks in on odd days, V every day, Z joins on day 10 and
/// checks in on days 20, 22, 24, W joins on day 5, leaves on day 15, joins again on day 16 and
/// checks in on day 30. Every day 1..30 fails (at most two check-ins, goal 3). On day 31
/// everyone leaves: no panic, `stake_pool == 0`, `active_stake == 0`, the 5 yocto of dust go to
/// the pot.
///
/// Python: a separate simulation of S6–S10 for this exact sequence (aggregate and personal
/// slashes as in the module header): X 4 239 115 827 521 620 351 427, Σ stakes
/// 166 924 069 019 943 089 351 427 vs stake_pool …432.
#[test]
fn t09b_end_to_end_30_failures_then_everyone_leaves() {
    const X30: u128 = 4_239_115_827_521_620_351_427;
    const POOL: u128 = 166_924_069_019_943_089_351_432;
    const POT30: u128 = 107_319_381_971_468_783_470_573_616;
    let mut p = params("demo");
    p.config.join_stake = U128(BIG_STAKE);
    let mut w = World::deploy(p);
    w.thorough = false;
    let [x, y, v, z, wa] = [user(0), user(1), user(2), user(3), user(4)];
    for day in 0..=30u32 {
        w.goto(day, 1);
        match day {
            0 => {
                for a in [&x, &y, &v] {
                    w.fund_and_join(a, None).unwrap();
                }
            }
            5 | 16 => w.fund_and_join(&wa, None).unwrap(),
            10 => w.fund_and_join(&z, None).unwrap(),
            15 => {
                // 9 failed days since activation on day 6: 10^23 × 0.9^9, fee 10%.
                assert_eq!(w.leave(&wa).unwrap(), 34_867_844_010_000_000_000_000);
            }
            _ => {}
        }
        if day >= 1 {
            w.check_in(&v).unwrap();
            if day % 2 == 1 {
                w.check_in(&y).unwrap();
            }
            if [20, 22, 24].contains(&day) {
                w.check_in(&z).unwrap();
            }
            if day == 30 {
                w.check_in(&wa).unwrap();
            }
        }
        w.check_full();
    }
    w.goto(31, 1);
    w.settle(None).unwrap();
    let fails =
        w.m.days
            .iter()
            .filter(|s| s.outcome == Outcome::Fail)
            .count();
    assert_eq!(fails, 30);
    assert_eq!(w.member(&x).unwrap().stake, X30);
    assert_eq!(w.c.stake_pool, POOL);
    assert_eq!(w.c.active_stake, POOL);
    assert_eq!(w.c.pot, POT30);
    let stakes: u128 = w.m.members.values().map(|m| m.stake).sum();
    assert_eq!(POOL - stakes, 5, "R1 dust");
    for (a, returned) in [
        (&x, 3_815_204_244_769_458_316_285),
        (&y, 18_530_201_888_518_410_000_000),
        (&v, 90_000_000_000_000_000_000_000),
        (&z, 15_009_463_529_699_912_100_000),
        (&wa, 22_876_792_454_961_000_000_000),
    ] {
        assert_eq!(w.leave(a).unwrap(), returned);
    }
    assert_eq!((w.c.stake_pool, w.c.active_stake), (0, 0));
    assert_eq!((w.c.open.active_stake, w.c.open.checked_stake), (0, 0));
    assert_eq!(w.c.pot, POT30 + 5, "the dust goes to the pot (R11)");
    w.check_full();
}

/// S18 18 end to end, all four kinds of leave in one run (demo set, `join_stake = 10^21 + 7` so
/// that one failed day leaves dust):
/// - day 1: A, B, C, D do not check in → Fail (2 yocto of dust);
/// - day 2: E joins and leaves in warmup (everything back, `maturing[3]` gone); A, B, C check in,
///   A leaves (no fee, `forfeited = 1`); D leaves without a check-in (fee burned);
/// - day 3: day 2 settles Success with 3 check-ins and 2 shares (`refs = count − 1`); B leaves
///   with its share (fee), C leaves last: the dust goes to the pot.
///
/// Python: personal ⌊S × 0.9⌋ = 900 000 000 000 000 000 006, aggregate 4S − ⌊4S / 10⌋ (2 yocto
/// more), ps2 = ⌊⌊0.95 × 5·10^26 × 1.1%⌋ / 13⌋.
#[test]
fn t18_end_to_end_all_four_leaves() {
    const S: u128 = 1_000_000_000_000_000_000_007;
    const S1: u128 = 900_000_000_000_000_000_006;
    const PS2: u128 = 401_923_076_923_076_923_076_923;
    const POT2: u128 = 470_176_923_076_923_076_923_076_924;
    let mut p = params("demo");
    p.config.join_stake = U128(S);
    let mut w = World::deploy(p);
    let [a, b, c, d, e] = [user(0), user(1), user(2), user(3), user(4)];
    for x in [&a, &b, &c, &d] {
        w.fund_and_join(x, None).unwrap();
    }
    w.goto(2, 0);
    w.settle(None).unwrap();
    assert_eq!(w.m.days[1].stake_slashed.0, 400_000_000_000_000_000_002);
    assert_eq!(w.c.stake_pool - 4 * S1, 2, "dust after one failed day");

    // Warmup: everything back, maturing[3] removed.
    w.fund_and_join(&e, None).unwrap();
    assert_eq!(w.c.maturing.get(&3), Some(&1));
    let burned = w.c.total_burned;
    assert_eq!(w.leave(&e).unwrap(), S);
    assert_eq!(w.balance(&e), S);
    assert_eq!(w.c.maturing.get(&3), None);
    assert_eq!(w.c.total_burned, burned);

    for x in [&a, &b, &c] {
        w.check_in(x).unwrap();
    }
    // Checked in today: no fee, the share of today is forfeited (R4).
    assert_eq!(w.leave(&a).unwrap(), S1);
    assert_eq!(w.c.total_burned, burned);
    assert_eq!((w.c.open.forfeited, w.c.open.count), (1, 3));
    // Not checked in: fee ⌊S1 / 10⌋ burned.
    assert_eq!(w.leave(&d).unwrap(), 810_000_000_000_000_000_006);
    assert_eq!(w.c.total_burned - burned, 90_000_000_000_000_000_000);
    assert_eq!(w.c.stake_pool, 1_800_000_000_000_000_000_014);

    w.goto(3, 0);
    w.settle(None).unwrap();
    assert_eq!(
        w.c.rewards.get(&2).copied(),
        Some(crate::types::DayReward {
            per_share: PS2,
            refs: 2
        })
    );
    assert_eq!(w.c.reserved, 2 * PS2);
    assert_eq!(w.c.pot, POT2);
    let before = w.balance(&b);
    assert_eq!(w.leave(&b).unwrap(), 810_000_000_000_000_000_006);
    assert_eq!(w.balance(&b) - before, 810_000_000_000_000_000_006 + PS2);
    assert_eq!(w.c.rewards.get(&2).map(|r| r.refs), Some(1));
    // The last member: the 2 yocto of dust go to the pot (R11).
    assert_eq!(w.leave(&c).unwrap(), 810_000_000_000_000_000_006);
    assert_eq!(w.c.pot, POT2 + 2);
    assert!(w.c.rewards.get(&2).is_none());
    assert_eq!((w.c.stake_pool, w.c.active_stake, w.c.reserved), (0, 0, 0));
}

/// S18 20: the largest valid configuration for a few days without overflow: total supply
/// `u128::MAX / 10^8`, budget == pot (`emit_bps 5000 × (10^4 + 1 × 10^4) = 10^8`), the largest
/// `jackpot_mult` and `closers_k`, burn and slash 100%, goal 100%, bounty 100%, the longest day.
///
/// Python: pot0 = 1 701 411 834 604 692 317 316 873 037 158, ps1 = ⌊pot0 / 1004⌋,
/// pot after day 1 = 698.
#[test]
fn t20_largest_valid_config_runs_without_overflow() {
    const MAX: u128 = u128::MAX / 100_000_000;
    const PS1: u128 = 1_694_633_301_399_095_933_582_542_865;
    let mut p = params("demo");
    p.total_supply = U128(MAX);
    p.pot_bps = 5000;
    p.faucet_bps = 0;
    let c = &mut p.config;
    c.day_length_s = 31_536_000;
    c.warmup_days = 1;
    c.goal_bps = 10_000;
    c.min_goal = 1;
    c.closers_k = 16;
    c.jackpot_mult = 1000;
    c.emit_bps = 5000;
    c.streak_step_bps = 10_000;
    c.streak_cap = 1;
    c.burn_bps = 10_000;
    c.slash_bps = 10_000;
    c.join_stake = U128(MAX / 10);
    c.faucet_amount = U128(0);
    c.inactive_days = 1;
    c.kick_bounty_bps = 10_000;
    let stake = MAX / 10;
    let mut w = World::deploy(p);
    let u = users(4);
    for a in &u {
        w.fund_and_join(a, None).unwrap();
    }
    let mut promises = Vec::new();
    w.goto(1, 0);
    for a in &u {
        w.check_in(a).unwrap();
    }
    w.goto(2, 0);
    for a in &u[..3] {
        w.check_in(a).unwrap();
        promises.extend(w.new_pick_hero_promises());
    }
    assert_eq!(w.m.days[1].per_share.0, PS1);
    assert_eq!(w.m.days[1].pot_after.0, 698);
    assert_eq!(w.c.pending_heroes[0].jackpot, 1000 * PS1);
    run_heroes(&mut w, &mut promises);
    assert_eq!(w.c.total_jackpots, 1000 * PS1);

    // Day 2 fails: the whole pot burns, the unchecked stake is slashed to 0.
    w.goto(3, 0);
    w.settle(None).unwrap();
    assert_eq!(
        (w.m.days[2].pot_burned.0, w.m.days[2].stake_slashed.0),
        (698, stake)
    );
    assert_eq!(w.c.pot, 0);
    assert_eq!(w.member(&u[3]).unwrap().stake, 0);
    // Kick of a zero stake: fee and bounty 0, the share of day 1 is paid.
    assert_eq!(w.kick(&u[0], &u[3]).unwrap(), 0);
    for a in &u[..3] {
        w.check_in(a).unwrap();
    }
    // Day 3: goal 4 (fixed at opening) → Fail with nothing left to burn or slash.
    w.goto(4, 0);
    for a in &u[..3] {
        w.check_in(a).unwrap();
    }
    assert_eq!(w.m.days[3].outcome, Outcome::Fail);
    assert_eq!(w.m.days[3].stake_slashed.0, 0);
    // Day 4: Success with pot 0 → no share, no record, no jackpot (I8, S18 16).
    w.goto(5, 0);
    w.settle(None).unwrap();
    assert_eq!(w.m.days[4].outcome, Outcome::Success);
    assert_eq!(w.m.days[4].per_share.0, 0);
    assert!(w.c.rewards.get(&4).is_none());
    assert!(w.c.pending_heroes.is_empty());
    // With slash_bps = 100% a leave without today's check-in burns the whole stake.
    assert_eq!(w.claim(&u[0]).unwrap(), PS1);
    assert_eq!(w.leave(&u[0]).unwrap(), 0);
    for a in &u[1..3] {
        w.check_in(a).unwrap();
        assert_eq!(w.claim(a).unwrap(), PS1);
        assert_eq!(w.leave(a).unwrap(), stake);
    }
    assert_eq!((w.c.stake_pool, w.c.members_total), (0, 0));
}

/// S18 24 end to end, demo set, six members (goal 4); u0 never checks in, u1..u5 do on days
/// 1..4 (u4, u5 stop after day 4).
/// - kick before the deadline (day 3) and in warmup → ERR_NOT_INACTIVE;
/// - day 4: u1 kicks u0: fee 10^20, bounty 2·10^19, the NEAR deposit goes back to u0 (receipt
///   checked against the model), aggregates drop; today's goal stays 4, day 5 opens with goal 3;
/// - day 8: u4 leaves, u5 (same history) kicks itself: it ends up with exactly the bounty more
///   (S10: a self-kick costs a leave minus the bounty).
#[test]
fn t24_end_to_end_kick_lowers_the_next_goal() {
    let u = users(7);
    let mut w = World::new("demo");
    for a in &u[..6] {
        w.fund_and_join(a, None).unwrap();
    }
    for day in 1..=3 {
        w.goto(day, 0);
        for a in &u[1..6] {
            w.check_in(a).unwrap();
        }
    }
    assert_eq!(w.kick(&u[1], &u[0]).unwrap_err(), ERR_NOT_INACTIVE);
    w.fund_and_join(&u[6], None).unwrap();
    assert_eq!(w.kick(&u[1], &u[6]).unwrap_err(), ERR_NOT_INACTIVE);
    // Keep six active members.
    assert_eq!(w.leave(&u[6]).unwrap(), DEMO_STAKE);

    w.goto(4, 0);
    w.settle(None).unwrap();
    assert_eq!(w.c.open.goal, 4);
    let before = w.balance(&u[1]);
    assert_eq!(w.kick(&u[1], &u[0]).unwrap(), 20_000_000_000_000_000_000);
    assert_eq!(w.balance(&u[1]) - before, 20_000_000_000_000_000_000);
    assert_eq!(w.balance(&u[0]), 900_000_000_000_000_000_000);
    assert_eq!(w.receipts.transfers, vec![(u[0].clone(), Some(DEPOSIT))]);
    assert_eq!((w.c.active_count, w.c.active_stake), (5, 5 * DEMO_STAKE));
    assert_eq!(w.c.open.goal, 4, "today's goal does not change");
    for a in &u[1..6] {
        w.check_in(a).unwrap();
    }
    w.goto(5, 0);
    w.settle(None).unwrap();
    assert_eq!(
        w.c.open.goal, 3,
        "the next day opens with 5 active: max(3, ⌈3⌉)"
    );

    for day in 5..=7 {
        w.goto(day, 0);
        for a in &u[1..4] {
            w.check_in(a).unwrap();
        }
    }
    w.goto(8, 0);
    let (b4, b5) = (w.balance(&u[4]), w.balance(&u[5]));
    assert_eq!(w.member(&u[4]).unwrap(), w.member(&u[5]).unwrap());
    assert_eq!(w.leave(&u[4]).unwrap(), 900_000_000_000_000_000_000);
    assert_eq!(w.kick(&u[5], &u[5]).unwrap(), 20_000_000_000_000_000_000);
    assert_eq!(
        w.balance(&u[5]) - b5,
        w.balance(&u[4]) - b4 + 20_000_000_000_000_000_000
    );
}

/// S18 29 end to end, mainnet set: ten members (10^23 each) active from day 2; days 2..31 fail
/// (30 failures, nobody checks in); on day 32 three check in and then all ten leave → day 32
/// settles Idle (no active members, R11): no burn, no slash, no failed bit, `stake_pool == 0`,
/// `open.*` zero. The 26 yocto of dust go to the pot at the last exit.
///
/// Python: 30 × (pot −= ⌊pot / 20⌋; aggregate −= ⌊aggregate / 10⌋; personal = ⌊personal × 0.9⌋):
/// personal 4 239 115 827 521 620 351 427, aggregate …514 296.
#[test]
fn t29_end_to_end_everyone_leaves_on_a_failing_day() {
    const PERSONAL: u128 = 4_239_115_827_521_620_351_427;
    const AGGREGATE: u128 = 42_391_158_275_216_203_514_296;
    const POT31: u128 = 107_319_381_971_468_783_470_573_616;
    let u = users(10);
    let mut w = World::new("mainnet");
    w.thorough = false;
    for a in &u {
        w.fund_and_join(a, None).unwrap();
    }
    for day in (2..=32).step_by(10) {
        w.goto(day, 0);
        w.settle(None).unwrap();
        w.check_full();
    }
    assert_eq!(
        w.m.days
            .iter()
            .filter(|s| s.outcome == Outcome::Fail)
            .count(),
        30
    );
    assert_eq!(w.c.active_stake, AGGREGATE);
    assert_eq!(w.c.pot, POT31);
    assert_eq!(w.c.open.goal, 6);
    for a in &u[..3] {
        w.check_in(a).unwrap();
    }
    let burned = w.c.total_burned;
    for (i, a) in u.iter().enumerate() {
        let want = if i < 3 {
            PERSONAL
        } else {
            3_815_204_244_769_458_316_285
        };
        assert_eq!(w.leave(a).unwrap(), want);
    }
    assert_eq!(w.c.total_burned - burned, 7 * 423_911_582_752_162_035_142);
    assert_eq!(w.c.pot, POT31 + 26, "the dust goes to the pot");
    assert_eq!(
        (w.c.stake_pool, w.c.active_stake, w.c.active_count),
        (0, 0, 0)
    );
    assert_eq!((w.c.open.count, w.c.open.forfeited), (3, 3));
    let burned = w.c.total_burned;
    w.goto(33, 0);
    w.settle(None).unwrap();
    let d32 = &w.m.days[32];
    assert_eq!((d32.outcome, d32.goal, d32.count), (Outcome::Idle, 6, 3));
    assert_eq!(w.c.total_burned, burned);
    assert_eq!(w.c.pot, POT31 + 26);
    assert!(!bits::is_set(&w.c.failed_bits, 32));
    assert_eq!(
        w.c.open,
        OpenDay {
            day: 33,
            ..OpenDay::default()
        }
    );
    w.check_full();
}

/// Heroes drawn late, out of order, twice, never, and for someone gone (S11, R10), demo set,
/// five members (goal 3, closers = the first three check-ins of a day):
/// - days 1 and 2 succeed; neither promise runs before day 3, so two heroes are pending;
/// - on day 3, u0 (a closer of both days) leaves and unregisters from the token;
/// - the day-2 promise runs first: seed 0 → index 0 → u3, paid;
/// - the day-1 promise runs: seed [2; 32] → index 0 → u0, not registered → the jackpot goes back
///   to the pot (`paid: false`), the history still names the hero; running it again is a no-op,
///   `retry_pick_hero(1)` → ERR_NO_PENDING_HERO;
/// - the day-3 promise is lost: `retry_pick_hero(3)` with low gas → ERR_LOW_GAS, then by a
///   stranger → a new promise → index 2 → u3 again.
///
/// Indices: Python `sha256(seed ‖ day_le ‖ "lastcall")[0..8]` little-endian % 3. Shares and pot
/// with the module-header formulas (the returned day-1 jackpot is in the pot when day 3 settles).
#[test]
fn heroes_late_out_of_order_and_lost() {
    const PS1: u128 = 366_666_666_666_666_666_666_666;
    const PS2: u128 = 395_600_000_000_000_000_000_000;
    const PS3: u128 = 457_073_190_476_190_476_190_476;
    const POT3: u128 = 485_833_642_000_000_000_000_000_006;
    let u = users(5);
    let mut w = World::new("demo");
    for a in &u {
        w.fund_and_join(a, None).unwrap();
    }
    w.goto(1, 0);
    for a in &u {
        w.check_in(a).unwrap();
    }
    w.goto(2, 0);
    let mut promises = Vec::new();
    for i in [3, 0, 1, 2, 4] {
        w.check_in(&u[i]).unwrap();
        promises.extend(w.new_pick_hero_promises());
    }
    w.goto(3, 0);
    w.check_in(&u[1]).unwrap();
    promises.extend(w.new_pick_hero_promises());
    assert_eq!(promises, vec![1, 2]);
    assert_eq!(w.c.pending_heroes.len(), 2);
    assert_eq!(
        w.c.pending_heroes[0].closers,
        vec![u[0].clone(), u[1].clone(), u[2].clone()]
    );
    assert_eq!(
        w.c.pending_heroes[1].closers,
        vec![u[3].clone(), u[0].clone(), u[1].clone()]
    );
    assert_eq!(w.c.jackpot_pending, 10 * PS1 + 10 * PS2);

    // u0 leaves (fee, shares of days 1 and 2) and unregisters: its balance burns.
    w.leave(&u[0]).unwrap();
    assert_eq!(w.balance(&u[0]), 763_166_666_666_666_666_666_666);
    let burned = w.c.total_burned;
    assert!(w.storage_unregister(&u[0], true).unwrap());
    assert_eq!(w.c.total_burned - burned, 763_166_666_666_666_666_666_666);

    w.pick_hero(2, [0; 32]);
    assert_eq!(w.member(&u[3]).unwrap().hero_count, 1);
    assert_eq!(
        w.c.history.get(&2).and_then(|s| s.hero.clone()),
        Some(u[3].clone())
    );
    let pot = w.c.pot;
    w.pick_hero(1, [2; 32]);
    assert_eq!(w.c.pot, pot + 10 * PS1, "unpaid jackpot back to the pot");
    assert_eq!(
        w.c.history.get(&1).and_then(|s| s.hero.clone()),
        Some(u[0].clone())
    );
    let hero_event = w
        .logs
        .iter()
        .find(|l| l.contains("\"event\":\"hero\""))
        .expect("hero event")
        .clone();
    assert!(hero_event.contains("\"paid\":false"), "{hero_event}");
    w.pick_hero(1, [9; 32]);
    assert_eq!(w.c.pot, pot + 10 * PS1, "a second run is a no-op");
    assert_eq!(
        w.retry_pick_hero(&stranger(), 1).unwrap_err(),
        ERR_NO_PENDING_HERO
    );
    assert_eq!(w.c.jackpot_pending, 0);

    for i in [2, 3, 4] {
        w.check_in(&u[i]).unwrap();
    }
    w.goto(4, 0);
    w.settle(None).unwrap();
    assert_eq!(w.new_pick_hero_promises(), vec![3]);
    assert_eq!(w.m.days[3].per_share.0, PS3);
    assert_eq!(w.c.pot, POT3);
    // The promise is lost; a retry needs the gas for a new one.
    w.low_gas = true;
    assert_eq!(w.retry_pick_hero(&stranger(), 3).unwrap_err(), ERR_LOW_GAS);
    w.low_gas = false;
    w.retry_pick_hero(&stranger(), 3).unwrap();
    assert_eq!(w.new_pick_hero_promises(), vec![3]);
    let before = w.balance(&u[3]);
    w.pick_hero(3, [0; 32]);
    assert_eq!(w.balance(&u[3]) - before, 10 * PS3);
    assert_eq!(w.member(&u[3]).unwrap().hero_count, 2);
    assert_eq!(w.c.total_jackpots, 10 * PS2 + 10 * PS3);
}

/// Errors behave as on chain (I9, S18 27, 31): a call that fails after its auto-settle leaves no
/// trace (rolled back, the days stay unsettled); ERR_BACKLOG and ERR_LOW_GAS come before any work
/// (`World` checks the state is untouched even without the rollback); NEP-141/145, faucet,
/// `set_checkin_key` and `retry_pick_hero` work through a backlog of more than 50 days.
#[test]
fn errors_roll_back_and_backlog_spares_nep_methods() {
    let u = users(4);
    let mut w = World::new("demo");
    for a in &u[..3] {
        w.fund_and_join(a, None).unwrap();
    }
    w.goto(1, 0);
    for a in &u[..3] {
        w.check_in(a).unwrap();
    }
    // Day 1 is about to settle as a success: an error after the settle undoes it.
    w.goto(2, 0);
    assert_eq!(w.check_in(&u[3]).unwrap_err(), ERR_NOT_MEMBER);
    assert_eq!(w.c.last_settled, Some(0));
    assert!(w.c.pending_heroes.is_empty());
    w.low_gas = true;
    assert_eq!(w.check_in(&u[0]).unwrap_err(), ERR_LOW_GAS);
    assert_eq!(w.settle(None).unwrap_err(), ERR_LOW_GAS);
    assert_eq!(
        w.settle(Some(0)).unwrap(),
        0,
        "nothing to settle, no gas check"
    );
    w.low_gas = false;
    assert_eq!(w.claim_with(&u[0], 0).unwrap_err(), ERR_ONE_YOCTO);
    w.check_in(&u[0]).unwrap();
    assert_eq!(w.c.last_settled, Some(1));
    assert_eq!(w.new_pick_hero_promises(), vec![1]);

    // 52 pending days: every game call fails before any work.
    w.goto(54, 0);
    assert_eq!(w.join(&u[3], None).unwrap_err(), ERR_BACKLOG);
    assert_eq!(w.check_in(&u[1]).unwrap_err(), ERR_BACKLOG);
    assert_eq!(w.claim(&u[1]).unwrap_err(), ERR_BACKLOG);
    assert_eq!(w.leave(&u[1]).unwrap_err(), ERR_BACKLOG);
    assert_eq!(w.kick(&u[3], &u[1]).unwrap_err(), ERR_BACKLOG);
    // NEP methods and the rest never touch days.
    w.fund(&u[3], 5);
    w.ft_transfer(&u[3], &u[0], 2).unwrap();
    w.faucet(&u[3]).unwrap();
    w.set_checkin_key(&u[1], Some(key_pair(1).1)).unwrap();
    w.retry_pick_hero(&u[3], 1).unwrap();
    w.pick_hero(1, [5; 32]);
    let balance = w.balance(&u[3]);
    assert!(w.storage_unregister(&u[3], true).unwrap());
    assert_eq!(
        w.c.total_burned
            - w.m
                .days
                .iter()
                .map(|d| d.pot_burned.0 + d.stake_slashed.0)
                .sum::<u128>(),
        balance
    );
    assert_eq!(w.c.last_settled, Some(1));
    // A partial settle brings the backlog under the cap.
    assert_eq!(w.settle(Some(2)).unwrap(), 2);
    w.check_in(&u[1]).unwrap();
    assert_eq!(w.c.last_settled, Some(53));
}

/// S18 11–12 through the signed path (R5): ten members (goal 6); four direct check-ins in their
/// own blocks, then a relayer sends five `check_in_signed` in one block, reaching the goal → only
/// the first of the batch becomes a candidate: closers = the four earlier ones + one from the batch.
#[test]
fn t12_signed_batch_in_one_block_gives_one_candidate() {
    let u = users(10);
    let keys: Vec<_> = (0..10).map(|i| key_pair(100 + i)).collect();
    let mut w = World::new("demo");
    for (a, (_, pk)) in u.iter().zip(&keys) {
        w.fund_and_join(a, Some(pk.clone())).unwrap();
    }
    w.goto(1, 0);
    for a in &u[..4] {
        assert!(w.check_in(a).unwrap().in_closers);
    }
    let relayer = stranger();
    w.next_block();
    w.auto_block = false;
    let mut flags = Vec::new();
    for (i, (a, (sk, _))) in u.iter().zip(&keys).enumerate().skip(4).take(5) {
        let nonce = [i as u8; 32];
        let sig = sign_check_in(sk, a, 1, nonce);
        let r = w
            .check_in_signed(&relayer, a, 1, nonce.to_vec(), sig, true)
            .unwrap();
        assert_eq!((r.n, r.goal), (i as u32 + 1, 6));
        flags.push(r.in_closers);
    }
    w.auto_block = true;
    assert_eq!(flags, vec![true, false, false, false, false]);
    assert_eq!(w.c.open.closers, u[..5].to_vec());
    assert!(w.logs.iter().any(|l| l.contains("\"via\":\"signed\"")));
}
