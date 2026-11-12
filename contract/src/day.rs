//! Day engine: time, auto-settle, settle, opening and settling days (spec S5, S6, S8). Owner: C5.

use near_contract_standards::fungible_token::events::FtBurn;
use near_sdk::json_types::U128;
use near_sdk::{env, require};

use crate::config::{AUTO_SETTLE_CAP, BPS_BASE, HISTORY_LEN, MAX_SETTLE_DAYS};
use crate::errors::ERR_BACKLOG;
use crate::events::{SettledRun, emit_days_settled};
use crate::types::{DayReward, DaySummary, OpenDay, Outcome, PendingHero};
use crate::{Contract, bits, ft, hero, math};

/// Nanoseconds per second.
const NS_PER_S: u64 = 1_000_000_000;

/// `((block_timestamp − launch_ns) / (day_length_s × 10^9)) as u32` (S5).
///
/// `day_length_s ≥ 10` (S3) keeps the quotient below `u64::MAX / 10^10 < u32::MAX`, so the cast
/// never truncates; `day_length_s ≤ 31 536 000` keeps the product far from `u64::MAX`.
pub fn today(c: &Contract) -> u32 {
    let elapsed = env::block_timestamp() - c.launch_ns;
    (elapsed / (c.config.day_length_s * NS_PER_S)) as u32
}

/// `last_settled.map_or(0, |d| d + 1)`; always equals `open.day` (S5).
pub fn next(c: &Contract) -> u32 {
    c.last_settled.map_or(0, |d| d + 1)
}

/// `today − next` (S5).
pub fn pending(c: &Contract) -> u32 {
    today(c) - next(c)
}

/// R6: `ERR_BACKLOG` and `ERR_LOW_GAS` before any work, then `settle_internal(pending)` (S5).
/// Called only by `join`, `check_in`, `check_in_signed`, `claim`, `leave`, `kick`.
pub fn auto_settle(c: &mut Contract) {
    let n = pending(c);
    require!(n <= AUTO_SETTLE_CAP, ERR_BACKLOG);
    require_gas_for(c, n);
    settle_internal(c, n);
}

/// Public `settle(max_days)` (S5): never `ERR_BACKLOG`; returns the number of settled days.
pub fn settle(c: &mut Contract, max_days: Option<u32>) -> u32 {
    let n = pending(c)
        .min(max_days.unwrap_or(MAX_SETTLE_DAYS))
        .min(MAX_SETTLE_DAYS);
    require_gas_for(c, n);
    settle_internal(c, n);
    n
}

/// Opens day `d` (S6).
pub fn open_day(c: &mut Contract, d: u32) {
    let m = c.maturing.remove(&d).unwrap_or(0);
    c.active_count += m;
    c.active_stake += u128::from(m) * c.config.join_stake.0;
    let goal = math::goal_for(c.active_count, c.config.min_goal, c.config.goal_bps);
    c.open = OpenDay {
        day: d,
        goal,
        active: c.active_count,
        active_stake: c.active_stake,
        count: 0,
        checked_stake: 0,
        forfeited: 0,
        closers: Vec::new(),
        closer_height: 0,
    };
}

/// The open day settles as a success (S8): only such a day schedules `pick_hero`.
fn open_day_succeeds(open: &OpenDay) -> bool {
    open.goal > 0 && open.count >= open.goal
}

/// S5: if `n` days are about to be settled and the first of them (the open day) is a success,
/// check the gas for the `pick_hero` promise before any work (`ERR_LOW_GAS`). Only the first day
/// of a batch can be a success: the others open during the batch with `count = 0` (S8).
fn require_gas_for(c: &Contract, n: u32) {
    if n > 0 && open_day_succeeds(&c.open) {
        hero::require_pick_hero_gas();
    }
}

/// `n` times `settle_open_day()`, then the batch events (S5, S15): at most one `ft_burn` (one
/// element) and one `days_settled`. The history ring is written only for the last `HISTORY_LEN`
/// days of the batch.
fn settle_internal(c: &mut Contract, n: u32) {
    if n == 0 {
        return;
    }
    let from = c.open.day;
    let to = from + (n - 1);
    let mut burned: u128 = 0;
    let mut runs: Vec<SettledRun> = Vec::new();
    for _ in 0..n {
        let summary = settle_open_day(c);
        let d = summary.day;
        burned += summary.pot_burned.0 + summary.stake_slashed.0;
        push_run(&mut runs, &summary);
        if to - d < HISTORY_LEN {
            c.history.insert(d % HISTORY_LEN, summary);
        }
    }
    // S8 burns `pot_burn + slash` per failed day; nothing reads the contract's FT balance or the
    // token's `total_supply` inside the batch, so one `internal_withdraw` of the batch sum gives
    // the same state with one storage write instead of one per failed day.
    if burned > 0 {
        ft::burn_from_contract(&mut c.token, burned);
        let memo = format!("days {from}..{to}");
        FtBurn {
            owner_id: &env::current_account_id(),
            amount: U128(burned),
            memo: Some(&memo),
        }
        .emit();
    }
    emit_days_settled(&runs);
}

/// Appends a settled day to the `days_settled` runs: consecutive empty days (`count == 0`) with
/// the same `outcome` and `goal` merge into one record with summed amounts (S15).
fn push_run(runs: &mut Vec<SettledRun>, s: &DaySummary) {
    if let Some(last) = runs.last_mut()
        && s.count == 0
        && last.count == 0
        && last.outcome == s.outcome
        && last.goal == s.goal
        && last.to_day + 1 == s.day
    {
        last.to_day = s.day;
        last.streak_after = s.streak_after;
        last.per_share = U128(last.per_share.0 + s.per_share.0);
        last.jackpot = U128(last.jackpot.0 + s.jackpot.0);
        last.pot_burned = U128(last.pot_burned.0 + s.pot_burned.0);
        last.stake_slashed = U128(last.stake_slashed.0 + s.stake_slashed.0);
        last.pot_after = s.pot_after;
        return;
    }
    runs.push(SettledRun {
        from_day: s.day,
        to_day: s.day,
        outcome: s.outcome,
        goal: s.goal,
        count: s.count,
        streak_after: s.streak_after,
        per_share: s.per_share,
        jackpot: s.jackpot,
        pot_burned: s.pot_burned,
        stake_slashed: s.stake_slashed,
        pot_after: s.pot_after,
    });
}

/// Settles the open day `d` (S8) and opens `d + 1`. Returns the day's summary (`hero = None`);
/// the caller writes it to the history ring and to the batch events. The FT burn of a failed day
/// (`pot_burn + slash`, already counted in `total_burned`) is done by the caller for the whole
/// batch.
fn settle_open_day(c: &mut Contract) -> DaySummary {
    let d = c.open.day;
    let outcome = if c.open.goal == 0 {
        Outcome::Idle
    } else if c.open.count >= c.open.goal {
        Outcome::Success
    } else if c.active_count == 0 {
        // All active members left during the day (R11).
        Outcome::Idle
    } else {
        Outcome::Fail
    };

    let mut per_share: u128 = 0;
    let mut jackpot_set_aside: u128 = 0;
    let mut pot_burn: u128 = 0;
    let mut slash: u128 = 0;
    match outcome {
        Outcome::Idle => {}
        Outcome::Success => {
            c.streak += 1;
            c.longest_streak = c.longest_streak.max(c.streak);
            let mult = math::mult_bps(c.streak, c.config.streak_cap, c.config.streak_step_bps);
            let budget = math::budget(c.pot, c.config.emit_bps, mult);
            per_share = math::per_share(budget, c.open.count, c.config.jackpot_mult);
            // R4: members who checked in today and left have no share.
            let shares = c.open.count - c.open.forfeited;
            if per_share > 0 && shares > 0 {
                let total = per_share * u128::from(shares);
                c.pot -= total;
                c.reserved += total;
                c.total_rewarded += total;
                c.rewards.insert(
                    d,
                    DayReward {
                        per_share,
                        refs: shares,
                    },
                );
            }
            let jackpot = per_share * u128::from(c.config.jackpot_mult);
            // R10: the hero is drawn in a separate receipt; an empty five keeps the jackpot in
            // the pot.
            if jackpot > 0 && !c.open.closers.is_empty() {
                c.pot -= jackpot;
                c.jackpot_pending += jackpot;
                c.pending_heroes.push(PendingHero {
                    day: d,
                    closers: c.open.closers.clone(),
                    jackpot,
                });
                hero::schedule_pick_hero(d);
                jackpot_set_aside = jackpot;
            }
        }
        Outcome::Fail => {
            c.streak = 0;
            pot_burn = c.pot * u128::from(c.config.burn_bps) / BPS_BASE;
            c.pot -= pot_burn;
            // R11: never more than the aggregate active stake.
            slash = math::aggregate_slash(
                c.open.active_stake,
                c.open.checked_stake,
                c.config.slash_bps,
            )
            .min(c.active_stake);
            c.stake_pool -= slash;
            c.active_stake -= slash;
            c.total_burned += pot_burn + slash;
            bits::set(&mut c.failed_bits, d);
        }
    }

    let summary = DaySummary {
        day: d,
        outcome,
        goal: c.open.goal,
        count: c.open.count,
        streak_after: c.streak,
        per_share: U128(per_share),
        hero: None,
        jackpot: U128(jackpot_set_aside),
        pot_burned: U128(pot_burn),
        stake_slashed: U128(slash),
        pot_after: U128(c.pot),
    };
    c.last_settled = Some(d);
    open_day(c, d + 1);
    summary
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs};
    use near_sdk::{AccountId, Gas, NearToken, serde_json};

    use super::*;
    use crate::config::PICK_HERO_GAS;
    use crate::errors::ERR_LOW_GAS;
    use crate::test_utils::*;

    /// mainnet `join_stake`: 10^23.
    const STAKE: u128 = 100_000_000_000_000_000_000_000;
    /// mainnet pot after `new`: 10^27 × 5000 / 10^4.
    const POT0: u128 = 500_000_000_000_000_000_000_000_000;
    /// mainnet `total_supply`: 10^27.
    const SUPPLY: u128 = 1_000_000_000_000_000_000_000_000_000;

    fn balance(c: &Contract) -> u128 {
        c.token.accounts.get(&contract_id()).unwrap_or(0)
    }

    /// The aggregate invariants this module can break: I1, I2, I12, I13, and `next == open.day`
    /// (S5). I8 (`budget ≤ pot`, `pot ≥ 0`) holds by the u128 subtractions not panicking.
    fn check(c: &Contract) {
        assert_eq!(
            balance(c),
            c.pot + c.reserved + c.stake_pool + c.faucet_left + c.jackpot_pending,
            "I1"
        );
        assert_eq!(
            c.token.total_supply,
            c.initial_supply - c.total_burned,
            "I2"
        );
        assert!(
            c.open.checked_stake <= c.open.active_stake,
            "I12 checked ≤ open.active"
        );
        assert!(
            c.open.active_stake <= c.active_stake,
            "I12 open.active ≤ active"
        );
        assert!(c.active_stake <= c.stake_pool, "I12 active ≤ pool");
        let pending: u128 = c.pending_heroes.iter().map(|p| p.jackpot).sum();
        assert_eq!(c.jackpot_pending, pending, "I13");
        assert_eq!(next(c), c.open.day, "next == open.day");
    }

    /// Like `n` joins whose members become active on `activation_day`: the stakes move from
    /// `owner()` to the contract (`stake_pool`), `maturing[activation_day] += n`.
    fn mature(c: &mut Contract, activation_day: u32, n: u32) {
        let stake = u128::from(n) * STAKE;
        c.token
            .internal_transfer(&owner(), &contract_id(), stake, None);
        c.stake_pool += stake;
        c.members_total += n;
        *c.maturing.entry(activation_day).or_insert(0) += n;
    }

    /// `n` check-ins of members with stake `stake` on the open day; the first `min(n, K)` become
    /// closers (as if each came in its own block).
    fn check_in(c: &mut Contract, n: u32, stake: u128) {
        let first = c.open.count;
        c.open.count += n;
        c.open.checked_stake += u128::from(n) * stake;
        for i in first..first + n {
            if c.open.closers.len() < c.config.closers_k as usize && i < c.open.goal {
                c.open.closers.push(user(i));
            }
        }
    }

    /// Everyone leaves on the open day without a fee (aggregate part of S10): the stakes are paid
    /// out to `owner()`, the last exit zeroes `open.*`.
    fn leave_all(c: &mut Contract) {
        c.token
            .internal_transfer(&contract_id(), &owner(), c.stake_pool, None);
        c.open.forfeited = c.open.count;
        c.stake_pool = 0;
        c.active_count = 0;
        c.active_stake = 0;
        c.members_total = 0;
        c.open.active_stake = 0;
        c.open.checked_stake = 0;
    }

    fn settle_at(c: &mut Contract, day: u32) -> u32 {
        set_time(day, 0);
        let n = settle(c, None);
        check(c);
        n
    }

    fn nep141(event: &str) -> Vec<serde_json::Value> {
        event_logs()
            .into_iter()
            .filter(|e| e["standard"] == "nep141" && e["event"] == event)
            .collect()
    }

    /// `data.runs` of the only `days_settled` log of the current context (`[]` if none).
    fn runs() -> Vec<serde_json::Value> {
        let logs: Vec<_> = event_logs()
            .into_iter()
            .filter(|e| e["standard"] == "lastcall" && e["event"] == "days_settled")
            .collect();
        assert!(logs.len() <= 1, "at most one days_settled per call");
        logs.first()
            .map(|e| e["data"]["runs"].as_array().cloned().unwrap_or_default())
            .unwrap_or_default()
    }

    /// Days of the `pick_hero` promises created in the current context; checks their shape.
    fn pick_hero_days() -> Vec<u32> {
        let mut days = Vec::new();
        for receipt in get_created_receipts() {
            for action in receipt.actions {
                if let MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } = action
                {
                    assert_eq!(receipt.receiver_id, contract_id());
                    assert_eq!(method_name, b"pick_hero");
                    assert_eq!(attached_deposit, NearToken::from_yoctonear(0));
                    assert_eq!(prepaid_gas, PICK_HERO_GAS);
                    let args: serde_json::Value = serde_json::from_slice(&args).unwrap();
                    days.push(u32::try_from(args["day"].as_u64().unwrap()).unwrap());
                }
            }
        }
        days
    }

    fn panic_message(f: impl FnOnce()) -> String {
        let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default()
    }

    #[derive(Debug, PartialEq)]
    struct Snapshot {
        last_settled: Option<u32>,
        open: OpenDay,
        pot: u128,
        reserved: u128,
        stake_pool: u128,
        jackpot_pending: u128,
        pending_heroes: Vec<PendingHero>,
        streak: u32,
        longest_streak: u32,
        active_count: u32,
        active_stake: u128,
        members_total: u32,
        total_burned: u128,
        total_rewarded: u128,
        supply: u128,
        balance: u128,
        maturing_1: Option<u32>,
        failed_word_0: Option<u64>,
        rewards_1: Option<DayReward>,
        history_1: Option<DaySummary>,
    }

    fn snapshot(c: &Contract) -> Snapshot {
        Snapshot {
            last_settled: c.last_settled,
            open: c.open.clone(),
            pot: c.pot,
            reserved: c.reserved,
            stake_pool: c.stake_pool,
            jackpot_pending: c.jackpot_pending,
            pending_heroes: c.pending_heroes.clone(),
            streak: c.streak,
            longest_streak: c.longest_streak,
            active_count: c.active_count,
            active_stake: c.active_stake,
            members_total: c.members_total,
            total_burned: c.total_burned,
            total_rewarded: c.total_rewarded,
            supply: c.token.total_supply,
            balance: balance(c),
            maturing_1: c.maturing.get(&1).copied(),
            failed_word_0: c.failed_bits.get(&0).copied(),
            rewards_1: c.rewards.get(&1).copied(),
            history_1: c.history.get(&1).cloned(),
        }
    }

    fn closers(n: u32) -> Vec<AccountId> {
        (0..n).map(user).collect()
    }

    #[test]
    fn time_today_next_pending() {
        let mut c = setup("mainnet");
        check(&c);
        set_time(0, 86_399);
        assert_eq!((today(&c), next(&c), pending(&c)), (0, 0, 0));
        set_time(1, 0);
        assert_eq!((today(&c), next(&c), pending(&c)), (1, 0, 1));
        set_time(5, 10);
        assert_eq!(pending(&c), 5);
        // max_days caps the batch.
        assert_eq!(settle(&mut c, Some(2)), 2);
        assert_eq!((c.last_settled, next(&c), pending(&c)), (Some(1), 2, 3));
        assert_eq!(settle(&mut c, Some(0)), 0);
        assert_eq!(settle(&mut c, None), 3);
        assert_eq!((c.last_settled, next(&c), pending(&c)), (Some(4), 5, 0));
        check(&c);
        // Nothing pending: no work, no logs.
        set_time(5, 20);
        assert_eq!(settle(&mut c, None), 0);
        assert!(get_logs().is_empty());
    }

    #[test]
    fn open_day_takes_maturing_members() {
        let mut c = setup("mainnet");
        mature(&mut c, 3, 9);
        assert_eq!(settle_at(&mut c, 3), 3);
        assert_eq!(c.maturing.get(&3), None);
        assert_eq!(c.active_count, 9);
        assert_eq!(c.active_stake, 9 * STAKE);
        // max(5, ceil(9 × 6000 / 10 000)) = max(5, ceil(5.4)) = 6.
        let expected = OpenDay {
            day: 3,
            goal: 6,
            active: 9,
            active_stake: 9 * STAKE,
            ..OpenDay::default()
        };
        assert_eq!(c.open, expected);
    }

    #[test]
    fn t05_idle_day() {
        let mut c = setup("mainnet");
        // 4 < min_goal 5 active from day 1.
        mature(&mut c, 1, 4);
        c.streak = 3;
        c.longest_streak = 7;
        assert_eq!(settle_at(&mut c, 1), 1);
        // Day 0: no active members at all → goal 0 → Idle.
        assert_eq!(c.history.get(&0).map(|s| s.outcome), Some(Outcome::Idle));
        assert_eq!((c.open.day, c.open.active, c.open.goal), (1, 4, 0));
        // Check-ins on an idle day are allowed and change nothing.
        check_in(&mut c, 3, STAKE);
        assert!(c.open.closers.is_empty());
        assert_eq!(settle_at(&mut c, 2), 1);

        assert_eq!((c.streak, c.longest_streak), (3, 7));
        assert_eq!(c.pot, POT0);
        assert_eq!((c.reserved, c.total_rewarded, c.total_burned), (0, 0, 0));
        assert_eq!(c.token.total_supply, SUPPLY);
        assert_eq!(c.stake_pool, 4 * STAKE);
        assert_eq!(c.active_stake, 4 * STAKE);
        assert_eq!(c.rewards.get(&1), None);
        assert!(!bits::is_set(&c.failed_bits, 0) && !bits::is_set(&c.failed_bits, 1));
        assert!(c.pending_heroes.is_empty());
        assert!(pick_hero_days().is_empty());
        assert!(nep141("ft_burn").is_empty());
        let summary = c.history.get(&1).cloned().unwrap();
        assert_eq!(summary.outcome, Outcome::Idle);
        assert_eq!(
            (summary.goal, summary.count, summary.streak_after),
            (0, 3, 3)
        );
        assert_eq!(summary.pot_after, U128(POT0));
        assert_eq!(
            runs(),
            vec![serde_json::json!({
                "from_day": 1, "to_day": 1, "outcome": "Idle", "goal": 0, "count": 3,
                "streak_after": 3, "per_share": "0", "jackpot": "0", "pot_burned": "0",
                "stake_slashed": "0", "pot_after": POT0.to_string(),
            })]
        );
    }

    #[test]
    fn t06_success_shares_streak_and_cap() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        // goal = max(5, ceil(10 × 0.6)) = 6; 7 check-ins, 5 closers.
        assert_eq!(c.open.goal, 6);
        check_in(&mut c, 7, STAKE);
        assert_eq!(c.open.closers, closers(5));
        assert_eq!(settle_at(&mut c, 2), 1);

        // streak 0 → 1: mult = 10 000 + 1 × 1000 = 11 000.
        // budget = 5·10^26 × 5 × 11 000 / 10^8 = 2.75·10^23; per_share = budget / (7 + 10).
        let ps1: u128 = 16_176_470_588_235_294_117_647;
        let jp1: u128 = 161_764_705_882_352_941_176_470; // ps1 × 10
        assert_eq!((c.streak, c.longest_streak), (1, 1));
        assert_eq!(
            c.rewards.get(&1).copied(),
            Some(DayReward {
                per_share: ps1,
                refs: 7,
            })
        );
        assert_eq!(c.reserved, 113_235_294_117_647_058_823_529); // ps1 × 7
        assert_eq!(c.total_rewarded, c.reserved);
        assert_eq!(c.jackpot_pending, jp1);
        // pot − ps1 × 7 − jackpot = 5·10^26 − ps1 × 17.
        assert_eq!(c.pot, 499_725_000_000_000_000_000_000_001);
        assert_eq!(
            c.pending_heroes,
            vec![PendingHero {
                day: 1,
                closers: closers(5),
                jackpot: jp1,
            }]
        );
        assert_eq!(pick_hero_days(), vec![1]);
        assert!(nep141("ft_burn").is_empty());
        let summary = c.history.get(&1).cloned().unwrap();
        assert_eq!(
            summary,
            DaySummary {
                day: 1,
                outcome: Outcome::Success,
                goal: 6,
                count: 7,
                streak_after: 1,
                per_share: U128(ps1),
                hero: None,
                jackpot: U128(jp1),
                pot_burned: U128(0),
                stake_slashed: U128(0),
                pot_after: U128(499_725_000_000_000_000_000_000_001),
            }
        );
        assert_eq!(
            runs(),
            vec![serde_json::json!({
                "from_day": 1, "to_day": 1, "outcome": "Success", "goal": 6, "count": 7,
                "streak_after": 1, "per_share": ps1.to_string(), "jackpot": jp1.to_string(),
                "pot_burned": "0", "stake_slashed": "0",
                "pot_after": "499725000000000000000000001",
            })]
        );

        // Day 2: streak 30 → 31 hits the cap 30: mult = 10 000 + 30 × 1000 = 40 000 (not 41 000).
        // longest_streak 40 stays.
        c.streak = 30;
        c.longest_streak = 40;
        check_in(&mut c, 6, STAKE);
        assert_eq!(settle_at(&mut c, 3), 1);
        // budget = 499 725 000 000 000 000 000 000 001 × 5 × 40 000 / 10^8 = 999 450·10^18 (floor);
        // per_share = budget / (6 + 10).
        let ps2: u128 = 62_465_625_000_000_000_000_000;
        let jp2: u128 = 624_656_250_000_000_000_000_000;
        assert_eq!((c.streak, c.longest_streak), (31, 40));
        assert_eq!(
            c.rewards.get(&2).copied(),
            Some(DayReward {
                per_share: ps2,
                refs: 6,
            })
        );
        assert_eq!(c.reserved, 488_029_044_117_647_058_823_529); // ps1 × 7 + ps2 × 6
        assert_eq!(c.total_rewarded, c.reserved);
        assert_eq!(c.pot, 498_725_550_000_000_000_000_000_001); // previous − ps2 × 16
        assert_eq!(c.jackpot_pending, jp1 + jp2);
        assert_eq!(c.pending_heroes.len(), 2);
        assert_eq!(pick_hero_days(), vec![2]);
        // Supply untouched by a success.
        assert_eq!((c.token.total_supply, c.total_burned), (SUPPLY, 0));
    }

    #[test]
    fn t07_fail_aggregate() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        c.streak = 4;
        c.longest_streak = 4;
        // 3 of 10 checked in, goal 6.
        check_in(&mut c, 3, STAKE);
        let balance_before = balance(&c);
        assert_eq!(settle_at(&mut c, 2), 1);

        // pot_burn = 5·10^26 × 500 / 10^4 = 2.5·10^25.
        let pot_burn: u128 = 25_000_000_000_000_000_000_000_000;
        // slash = (10 − 3) × 10^23 × 1000 / 10^4 = 7·10^22.
        let slash: u128 = 70_000_000_000_000_000_000_000;
        let burned = pot_burn + slash;
        assert_eq!((c.streak, c.longest_streak), (0, 4));
        assert_eq!(c.pot, 475_000_000_000_000_000_000_000_000);
        assert_eq!(c.stake_pool, 930_000_000_000_000_000_000_000);
        assert_eq!(c.active_stake, 930_000_000_000_000_000_000_000);
        assert_eq!(c.open.active_stake, c.active_stake);
        assert_eq!(c.total_burned, burned);
        assert_eq!(c.token.total_supply, SUPPLY - burned);
        assert_eq!(balance(&c), balance_before - burned);
        assert!(bits::is_set(&c.failed_bits, 1));
        assert_eq!(c.rewards.get(&1), None);
        assert!(c.pending_heroes.is_empty());
        assert!(pick_hero_days().is_empty());

        let burns = nep141("ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(
            burns[0]["data"],
            serde_json::json!([{
                "owner_id": "lastcall.near",
                "amount": burned.to_string(),
                "memo": "days 1..1",
            }])
        );
        assert_eq!(
            runs(),
            vec![serde_json::json!({
                "from_day": 1, "to_day": 1, "outcome": "Fail", "goal": 6, "count": 3,
                "streak_after": 0, "per_share": "0", "jackpot": "0",
                "pot_burned": pot_burn.to_string(), "stake_slashed": slash.to_string(),
                "pot_after": "475000000000000000000000000",
            })]
        );
    }

    #[test]
    fn t09_three_empty_days_and_word_boundaries() {
        let mut c = setup("mainnet");
        // An odd pot so that the floor matters on every step.
        c.token
            .internal_transfer(&owner(), &contract_id(), 123_456_789, None);
        c.pot += 123_456_789;
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        assert_eq!(settle_at(&mut c, 4), 3);

        // pot × 0.95 with floor on every step:
        //   500 000 000 000 000 000 123 456 789 − 25 000 000 000 000 000 006 172 839
        //   475 000 000 000 000 000 117 283 950 − 23 750 000 000 000 000 005 864 197
        //   451 250 000 000 000 000 111 419 753 − 22 562 500 000 000 000 005 570 987
        let pot_after: u128 = 428_687_500_000_000_000_105_848_766;
        let pot_burned: u128 = 71_312_500_000_000_000_017_608_023;
        // active_stake × 0.9³: 10^24 → 9·10^23 → 8.1·10^23 → 7.29·10^23.
        let slashed: u128 = 271_000_000_000_000_000_000_000;
        assert_eq!(c.pot, pot_after);
        assert_eq!(c.active_stake, 729_000_000_000_000_000_000_000);
        assert_eq!(c.stake_pool, 729_000_000_000_000_000_000_000);
        assert_eq!(c.total_burned, pot_burned + slashed);
        assert_eq!(c.token.total_supply, SUPPLY - pot_burned - slashed);
        assert_eq!(c.streak, 0);
        for d in 1..=3 {
            assert!(bits::is_set(&c.failed_bits, d));
            assert_eq!(c.history.get(&d).map(|s| s.outcome), Some(Outcome::Fail));
        }
        assert!(!bits::is_set(&c.failed_bits, 0));
        assert!(!bits::is_set(&c.failed_bits, 4));
        let day1 = c.history.get(&1).cloned().unwrap();
        assert_eq!(day1.pot_burned, U128(25_000_000_000_000_000_006_172_839));
        assert_eq!(day1.stake_slashed, U128(100_000_000_000_000_000_000_000));
        assert_eq!(day1.pot_after, U128(475_000_000_000_000_000_117_283_950));

        let burns = nep141("ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(
            burns[0]["data"],
            serde_json::json!([{
                "owner_id": "lastcall.near",
                "amount": (pot_burned + slashed).to_string(),
                "memo": "days 1..3",
            }])
        );
        // Three empty fail days with the same goal → one record with sums.
        assert_eq!(
            runs(),
            vec![serde_json::json!({
                "from_day": 1, "to_day": 3, "outcome": "Fail", "goal": 6, "count": 0,
                "streak_after": 0, "per_share": "0", "jackpot": "0",
                "pot_burned": pot_burned.to_string(), "stake_slashed": slashed.to_string(),
                "pot_after": pot_after.to_string(),
            })]
        );

        // Days 4..=66 fail too: bits across the word boundary 63/64/65.
        assert_eq!(settle_at(&mut c, 67), 63);
        for d in [62, 63, 64, 65, 66] {
            assert!(bits::is_set(&c.failed_bits, d), "bit {d}");
        }
        assert!(!bits::is_set(&c.failed_bits, 67));
        assert_eq!(bits::count(&c.failed_bits, 0, 67), 66);
        assert_eq!(nep141("ft_burn").len(), 1);
    }

    #[test]
    fn days_settled_merges_only_empty_days_with_same_outcome_and_goal() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 5);
        mature(&mut c, 3, 5);
        settle_at(&mut c, 1);
        // Day 1: 2 check-ins (goal 5) → a fail record of its own.
        check_in(&mut c, 2, STAKE);
        assert_eq!(settle_at(&mut c, 5), 4);
        let got: Vec<_> = runs()
            .iter()
            .map(|r| {
                (
                    r["from_day"].as_u64().unwrap(),
                    r["to_day"].as_u64().unwrap(),
                    r["outcome"].as_str().unwrap().to_owned(),
                    r["goal"].as_u64().unwrap(),
                    r["count"].as_u64().unwrap(),
                )
            })
            .collect();
        let fail = || "Fail".to_owned();
        // Day 2: goal 5, empty; days 3–4: 10 active → goal 6.
        assert_eq!(
            got,
            vec![
                (1, 1, fail(), 5, 2),
                (2, 2, fail(), 5, 0),
                (3, 4, fail(), 6, 0)
            ]
        );
        let memo = &nep141("ft_burn")[0]["data"][0]["memo"];
        assert_eq!(memo, "days 1..4");
    }

    #[test]
    fn t10_backlog_before_any_work() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        set_time(51, 0);
        assert_eq!(pending(&c), 51);
        let before = snapshot(&c);
        let msg = panic_message(|| auto_settle(&mut c));
        assert_eq!(msg, ERR_BACKLOG);
        assert_eq!(snapshot(&c), before);
        assert!(get_logs().is_empty());
        assert!(get_created_receipts().is_empty());

        // `settle` never gives ERR_BACKLOG; one day brings pending to the cap 50.
        assert_eq!(settle(&mut c, Some(1)), 1);
        assert_eq!(pending(&c), 50);
        set_time(51, 1);
        auto_settle(&mut c);
        check(&c);
        // I9: after a game call `last_settled == today − 1`.
        assert_eq!(c.last_settled, Some(today(&c) - 1));
        assert_eq!(pending(&c), 0);
        assert_eq!(nep141("ft_burn").len(), 1);
        // No pending days: auto_settle does nothing.
        set_time(51, 2);
        auto_settle(&mut c);
        assert!(get_logs().is_empty());
    }

    #[test]
    fn t10_settle_600_days_in_two_calls() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        set_time(600, 0);
        assert_eq!(settle(&mut c, None), MAX_SETTLE_DAYS);
        check(&c);
        assert_eq!(c.last_settled, Some(499));
        let logs = get_logs();
        assert!(logs.len() <= 2);
        let bytes: usize = logs.iter().map(String::len).sum();
        assert!(bytes < 16_384, "logs {bytes} bytes");
        let burns = nep141("ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(burns[0]["data"].as_array().unwrap().len(), 1);
        assert_eq!(burns[0]["data"][0]["memo"], "days 0..499");
        let r = runs();
        assert_eq!(r.len(), 2);
        assert_eq!((&r[0]["from_day"], &r[0]["to_day"]), (&0.into(), &0.into()));
        assert_eq!(
            (&r[1]["from_day"], &r[1]["to_day"]),
            (&1.into(), &499.into())
        );
        // Ring: only the last 64 days of the batch.
        for slot in 0..HISTORY_LEN {
            let day = c.history.get(&slot).unwrap().day;
            assert!((436..=499).contains(&day), "slot {slot}: day {day}");
            assert_eq!(day % HISTORY_LEN, slot);
        }

        set_time(600, 1);
        assert_eq!(settle(&mut c, None), 100);
        check(&c);
        assert_eq!((c.last_settled, pending(&c)), (Some(599), 0));
        let bytes: usize = get_logs().iter().map(String::len).sum();
        assert!(bytes < 16_384, "logs {bytes} bytes");
        let burns = nep141("ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(burns[0]["data"].as_array().unwrap().len(), 1);
        assert_eq!(burns[0]["data"][0]["memo"], "days 500..599");
        assert_eq!(runs().len(), 1);
        for slot in 0..HISTORY_LEN {
            let day = c.history.get(&slot).unwrap().day;
            assert!((536..=599).contains(&day), "slot {slot}: day {day}");
        }

        set_time(600, 2);
        assert_eq!(settle(&mut c, None), 0);
        assert!(get_logs().is_empty());
    }

    #[test]
    fn t13_closers_and_pending_hero_only_on_success() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        check_in(&mut c, 6, STAKE);
        assert_eq!(settle_at(&mut c, 2), 1);
        assert_eq!(c.history.get(&1).map(|s| s.outcome), Some(Outcome::Success));
        assert_eq!(c.pending_heroes.len(), 1);
        assert_eq!(c.pending_heroes[0].day, 1);
        assert_eq!(c.pending_heroes[0].closers, closers(5));
        assert!(c.pending_heroes[0].jackpot > 0);
        assert_eq!(pick_hero_days(), vec![1]);

        // Day 2 fails: no jackpot.
        check_in(&mut c, 2, STAKE);
        assert_eq!(settle_at(&mut c, 3), 1);
        assert_eq!(c.history.get(&2).map(|s| s.outcome), Some(Outcome::Fail));
        assert_eq!(c.history.get(&2).map(|s| s.jackpot), Some(U128(0)));
        assert_eq!(c.pending_heroes.len(), 1);
        assert!(pick_hero_days().is_empty());

        // Idle day (goal 0): no jackpot even with check-ins.
        c.active_count = 4;
        open_day(&mut c, 3);
        assert_eq!(c.open.goal, 0);
        check_in(&mut c, 4, 0);
        assert_eq!(settle_at(&mut c, 4), 1);
        assert_eq!(c.history.get(&3).map(|s| s.outcome), Some(Outcome::Idle));
        assert_eq!(c.pending_heroes.len(), 1);
        assert!(pick_hero_days().is_empty());
    }

    #[test]
    fn success_with_empty_closers_keeps_jackpot_in_pot() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        check_in(&mut c, 7, STAKE);
        c.open.closers.clear();
        assert_eq!(settle_at(&mut c, 2), 1);
        let ps1: u128 = 16_176_470_588_235_294_117_647;
        assert_eq!(c.reserved, ps1 * 7);
        // Only the shares left the pot.
        assert_eq!(c.pot, POT0 - ps1 * 7);
        assert_eq!(c.jackpot_pending, 0);
        assert!(c.pending_heroes.is_empty());
        assert!(pick_hero_days().is_empty());
        assert_eq!(c.history.get(&1).map(|s| s.jackpot), Some(U128(0)));
    }

    #[test]
    fn r4_shares_exclude_forfeited() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        check_in(&mut c, 7, STAKE);
        // Two of the seven leave after checking in (S10, no fee): the aggregates drop by their
        // stakes, `forfeited += 1` each; `count` stays 7.
        c.token
            .internal_transfer(&contract_id(), &owner(), 2 * STAKE, None);
        c.stake_pool -= 2 * STAKE;
        c.active_count -= 2;
        c.active_stake -= 2 * STAKE;
        c.members_total -= 2;
        c.open.active_stake -= 2 * STAKE;
        c.open.checked_stake -= 2 * STAKE;
        c.open.forfeited = 2;
        check(&c);
        assert_eq!(settle_at(&mut c, 2), 1);

        // per_share still divides by count + jackpot_mult = 17; shares = 7 − 2 = 5.
        let ps: u128 = 16_176_470_588_235_294_117_647;
        assert_eq!(
            c.rewards.get(&1).copied(),
            Some(DayReward {
                per_share: ps,
                refs: 5,
            })
        );
        assert_eq!(c.reserved, 80_882_352_941_176_470_588_235); // ps × 5
        assert_eq!(c.total_rewarded, c.reserved);
        assert_eq!(c.jackpot_pending, ps * 10);
        assert_eq!(c.pot, 499_757_352_941_176_470_588_235_295); // 5·10^26 − ps × 15
        assert_eq!(c.history.get(&1).map(|s| s.count), Some(7));
    }

    #[test]
    fn r4_all_checked_left_no_rewards_record_but_jackpot() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        check_in(&mut c, 6, STAKE);
        // All six who checked in leave; four unchecked members stay active.
        c.token
            .internal_transfer(&contract_id(), &owner(), 6 * STAKE, None);
        c.stake_pool -= 6 * STAKE;
        c.active_count -= 6;
        c.active_stake -= 6 * STAKE;
        c.members_total -= 6;
        c.open.active_stake -= 6 * STAKE;
        c.open.checked_stake -= 6 * STAKE;
        c.open.forfeited = 6;
        check(&c);
        assert_eq!(settle_at(&mut c, 2), 1);
        assert_eq!(c.history.get(&1).map(|s| s.outcome), Some(Outcome::Success));
        assert_eq!(c.rewards.get(&1), None);
        assert_eq!((c.reserved, c.total_rewarded), (0, 0));
        // budget 2.75·10^23 / (6 + 10); the jackpot still goes to the five.
        let ps: u128 = 17_187_500_000_000_000_000_000;
        assert_eq!(c.jackpot_pending, ps * 10);
        assert_eq!(c.pot, POT0 - ps * 10);
        assert_eq!(pick_hero_days(), vec![1]);
    }

    #[test]
    fn t16_zero_pot() {
        let mut c = setup("mainnet");
        // Pot drained, stakes slashed to nothing: 10 active members with zero stake.
        c.token
            .internal_transfer(&contract_id(), &owner(), POT0, None);
        c.pot = 0;
        c.active_count = 10;
        c.members_total = 10;
        open_day(&mut c, 0);
        assert_eq!(c.open.goal, 6);
        check(&c);
        check_in(&mut c, 6, 0);
        assert_eq!(settle_at(&mut c, 1), 1);
        // Success without rewards or a hero.
        assert_eq!(c.history.get(&0).map(|s| s.outcome), Some(Outcome::Success));
        assert_eq!((c.streak, c.longest_streak), (1, 1));
        assert_eq!(c.rewards.get(&0), None);
        assert_eq!((c.reserved, c.total_rewarded, c.jackpot_pending), (0, 0, 0));
        assert!(c.pending_heroes.is_empty());
        assert!(pick_hero_days().is_empty());
        assert_eq!(c.history.get(&0).map(|s| s.per_share), Some(U128(0)));

        // Fail burns 0 and writes no ft_burn.
        assert_eq!(settle_at(&mut c, 2), 1);
        assert_eq!(c.history.get(&1).map(|s| s.outcome), Some(Outcome::Fail));
        assert_eq!(c.streak, 0);
        assert!(bits::is_set(&c.failed_bits, 1));
        assert_eq!(c.total_burned, 0);
        assert_eq!(c.token.total_supply, SUPPLY);
        assert!(nep141("ft_burn").is_empty());
        assert_eq!(runs().len(), 1);
    }

    #[test]
    fn t29_everyone_left_on_a_failing_day_is_idle() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        // 30 fails (days 1..=30).
        assert_eq!(settle_at(&mut c, 31), 30);
        assert_eq!(bits::count(&c.failed_bits, 0, 31), 30);
        assert_eq!(c.open.goal, 6);
        // Day 31: three check in, then everyone leaves.
        let per_member = c.active_stake / 10;
        check_in(&mut c, 3, per_member);
        leave_all(&mut c);
        check(&c);
        let burned_before = c.total_burned;
        let pot_before = c.pot;
        c.streak = 2;
        assert_eq!(settle_at(&mut c, 32), 1);

        assert_eq!(c.history.get(&31).map(|s| s.outcome), Some(Outcome::Idle));
        assert_eq!(c.history.get(&31).map(|s| s.goal), Some(6));
        assert_eq!(c.total_burned, burned_before);
        assert_eq!(c.pot, pot_before);
        assert_eq!(c.streak, 2);
        assert!(!bits::is_set(&c.failed_bits, 31));
        assert!(nep141("ft_burn").is_empty());
        assert_eq!(c.stake_pool, 0);
        let expected = OpenDay {
            day: 32,
            ..OpenDay::default()
        };
        assert_eq!(c.open, expected);
    }

    #[test]
    fn r11_slash_never_exceeds_active_stake() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        // Defensive branch: the aggregate lags the snapshot (as after `saturating_sub` in exit).
        c.active_stake = 5;
        set_time(2, 0);
        assert_eq!(settle(&mut c, None), 1);
        assert_eq!(c.history.get(&1).map(|s| s.stake_slashed), Some(U128(5)));
        assert_eq!(c.active_stake, 0);
        assert_eq!(c.stake_pool, 10 * STAKE - 5);
        check(&c);
    }

    #[test]
    fn t31_low_gas_on_a_successful_day_before_work() {
        let mut c = setup("mainnet");
        mature(&mut c, 1, 10);
        settle_at(&mut c, 1);
        check_in(&mut c, 6, STAKE);
        set_time(2, 0);
        // < PICK_HERO_GAS + GAS_RESERVE = 15 Tgas.
        set_prepaid_gas(Gas::from_tgas(14));
        let before = snapshot(&c);
        assert_eq!(
            panic_message(|| {
                settle(&mut c, None);
            }),
            ERR_LOW_GAS
        );
        assert_eq!(panic_message(|| auto_settle(&mut c)), ERR_LOW_GAS);
        assert_eq!(snapshot(&c), before);
        assert!(get_logs().is_empty());
        assert!(get_created_receipts().is_empty());
        // Nothing to settle → no check.
        assert_eq!(settle(&mut c, Some(0)), 0);

        set_prepaid_gas(Gas::from_tgas(300));
        assert_eq!(settle(&mut c, None), 1);
        check(&c);
        assert_eq!(pick_hero_days(), vec![1]);

        // A failing day needs no hero gas.
        set_time(3, 0);
        set_prepaid_gas(Gas::from_tgas(14));
        auto_settle(&mut c);
        check(&c);
        assert_eq!(c.history.get(&2).map(|s| s.outcome), Some(Outcome::Fail));
    }
}
