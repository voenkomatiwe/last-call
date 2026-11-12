//! View methods (spec S14). Owner: C7.
//!
//! Views never write to storage. Day numbers come from `day::today` / `day::next` / `day::pending`
//! (S5); a member's lazy state is derived with `member::resolve_pure` over settled days only.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env};

use crate::config::{AUTO_SETTLE_CAP, HISTORY_LEN, MAX_SETTLE_DAYS};
use crate::types::{
    ConfigView, DaySummary, KickablePage, Member, MemberView, OpenDayView, StateView,
};
use crate::{Contract, day, member};

/// Nanoseconds per second.
const NS_PER_S: u64 = 1_000_000_000;
/// Nanoseconds per millisecond.
const NS_PER_MS: u64 = 1_000_000;

pub fn get_config(c: &Contract) -> ConfigView {
    ConfigView {
        config: c.config.clone(),
        pot_bps: c.pot_bps,
        faucet_bps: c.faucet_bps,
        initial_supply: U128(c.initial_supply),
        launch_ns: U64(c.launch_ns),
        auto_settle_cap: AUTO_SETTLE_CAP,
        max_settle_days: MAX_SETTLE_DAYS,
        history_len: HISTORY_LEN,
    }
}

pub fn get_state(c: &Contract) -> StateView {
    StateView {
        today: day::today(c),
        last_settled: c.last_settled,
        pending_days: day::pending(c),
        pot: U128(c.pot),
        reserved: U128(c.reserved),
        stake_pool: U128(c.stake_pool),
        faucet_left: U128(c.faucet_left),
        jackpot_pending: U128(c.jackpot_pending),
        pending_hero_days: c.pending_heroes.iter().map(|h| h.day).collect(),
        streak: c.streak,
        longest_streak: c.longest_streak,
        active_count: c.active_count,
        active_stake: U128(c.active_stake),
        members_total: c.members_total,
        total_supply: U128(c.token.total_supply),
        total_burned: U128(c.total_burned),
        total_rewarded: U128(c.total_rewarded),
        total_jackpots: U128(c.total_jackpots),
        ms_to_day_end: ms_to_day_end(c),
    }
}

/// Milliseconds until the end of the current day `today` (rounded down): the day ends at
/// `launch_ns + (today + 1) × day_length_s × 10^9`. At the first nanosecond of a day it is the full
/// day length; in the last millisecond of a day it is 0.
///
/// The same subtraction and product as `day::today` (S5): `block_timestamp ≥ launch_ns` on chain,
/// `day_length_s ≤ 31 536 000` (S3) keeps `day_ns` far from `u64::MAX`.
fn ms_to_day_end(c: &Contract) -> u64 {
    let day_ns = c.config.day_length_s * NS_PER_S;
    let elapsed = env::block_timestamp() - c.launch_ns;
    (day_ns - elapsed % day_ns) / NS_PER_MS
}

pub fn get_open_day(c: &Contract) -> OpenDayView {
    let open = &c.open;
    OpenDayView {
        day: open.day,
        goal: open.goal,
        count: open.count,
        active: open.active,
        forfeited: open.forfeited,
        closers: open.closers.clone(),
        is_idle: open.goal == 0,
        stale: open.day < day::today(c),
    }
}

/// From `last_settled` backwards, at most `min(limit, HISTORY_LEN)`, newest first; slots holding
/// another day are skipped.
///
/// Walks the days `last_settled, last_settled − 1, …` (at most `min(limit, HISTORY_LEN)` of them,
/// not below day 0): a day further back shares its slot with a newer day and cannot be in the ring.
pub fn get_history(c: &Contract, limit: u32) -> Vec<DaySummary> {
    let Some(last) = c.last_settled else {
        return Vec::new();
    };
    // `last + 1` days exist (0..=last); u64 because `last` may be u32::MAX.
    let n = u64::from(limit.min(HISTORY_LEN)).min(u64::from(last) + 1) as u32;
    (0..n)
        .map(|back| last - back)
        .filter_map(|d| c.history.get(&(d % HISTORY_LEN)).filter(|s| s.day == d))
        .cloned()
        .collect()
}

/// `resolve_pure` with `t = next` (settled days only), no writes.
pub fn get_member(c: &Contract, account_id: AccountId) -> Option<MemberView> {
    let m = c.members.get(&account_id)?;
    let today = day::today(c);
    let delta = member::resolve_pure(c, m, day::next(c));

    let is_active = m.activation_day <= today;
    let checked_in_today = m.last_checkin == Some(today);
    // Checked in yesterday or today (`last_checkin ≥ today − 1`), otherwise the streak is broken.
    let streak_alive = m.last_checkin.is_some_and(|p| p >= today.saturating_sub(1));

    Some(MemberView {
        stake: U128(m.stake),
        join_day: m.join_day,
        activation_day: m.activation_day,
        last_checkin: m.last_checkin,
        resolved_through: m.resolved_through,
        claimable: U128(m.claimable),
        checkins: m.checkins,
        personal_streak: m.personal_streak,
        best_personal_streak: m.best_personal_streak,
        hero_count: m.hero_count,
        storage_deposit: U128(m.storage_deposit),
        checkin_key: m.checkin_key.clone(),
        effective_stake: U128(delta.stake),
        pending_claimable: U128(m.claimable + delta.claimable_add),
        is_active,
        can_check_in_today: is_active && !checked_in_today,
        checked_in_today,
        kickable_from_day: kickable_from_day(c, m, today),
        current_personal_streak: if streak_alive { m.personal_streak } else { 0 },
    })
}

/// S10: `None` during warmup (`activation_day > today`), otherwise `since + inactive_days` with
/// `since = last_checkin.map_or(activation_day, |p| p + 1)`.
///
/// Saturating: `inactive_days` has no upper bound in S3; `u32::MAX` means "never", and a view must
/// not panic on a valid config.
fn kickable_from_day(c: &Contract, m: &Member, today: u32) -> Option<u32> {
    if m.activation_day > today {
        return None;
    }
    let since = m
        .last_checkin
        .map_or(m.activation_day, |p| p.saturating_add(1));
    Some(since.saturating_add(c.config.inactive_days))
}

/// Filter within the index window `[from_index, from_index + limit)` of `members`.
///
/// Keeps the members `kick` accepts now (S10): `activation_day ≤ today && today ≥
/// kickable_from_day`. `next_index = Some(from_index + limit)` while members exist past the window,
/// otherwise `None`; the page may be empty while `next_index` is `Some`. `limit == 0` → an empty
/// page with `next_index = None` (nothing requested, nothing to continue).
pub fn get_kickable(c: &Contract, from_index: u32, limit: u32) -> KickablePage {
    if limit == 0 {
        return KickablePage {
            accounts: Vec::new(),
            next_index: None,
        };
    }
    let today = day::today(c);
    let accounts = c
        .members
        .iter()
        // `Iter::nth` jumps by index, so `skip` does not read the skipped members.
        .skip(from_index as usize)
        .take(limit as usize)
        .filter(|(_, m)| kickable_from_day(c, m, today).is_some_and(|k| today >= k))
        .map(|(account_id, _)| account_id.clone())
        .collect();
    // u64: `from_index + limit` may exceed u32::MAX; then nothing is past the window.
    let end = u64::from(from_index) + u64::from(limit);
    let next_index = if end < u64::from(c.members.len()) {
        // end < len ≤ u32::MAX.
        Some(end as u32)
    } else {
        None
    };
    KickablePage {
        accounts,
        next_index,
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PublicKey, testing_env};

    use super::*;
    use crate::bits;
    use crate::ft;
    use crate::test_utils::{
        LAUNCH_NS, NO_DEPOSIT, ONE_YOCTO, alice, bob, carol, context, contract_id, dave, eve,
        frank, params, register_and_fund, set_height, set_time, setup,
    };
    use crate::types::{DayReward, OpenDay, Outcome, PendingHero};

    /// `join_stake` of the demo set: 10^21.
    const STAKE: u128 = 1_000_000_000_000_000_000_000;
    /// 10^27: `total_supply` of every set.
    const SUPPLY: u128 = 1_000_000_000_000_000_000_000_000_000;
    /// `member_storage_deposit` of every set: 10^22 yocto.
    const STORAGE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

    /// A member who joined the day before `activation_day` (demo: warmup 1) and was never resolved.
    fn member(activation_day: u32, last_checkin: Option<u32>) -> Member {
        Member {
            stake: STAKE,
            join_day: activation_day.saturating_sub(1),
            activation_day,
            last_checkin,
            resolved_through: activation_day,
            claimable: 0,
            checkins: 0,
            personal_streak: 0,
            best_personal_streak: 0,
            hero_count: 0,
            storage_deposit: STORAGE_DEPOSIT,
            checkin_key: None,
        }
    }

    /// A history slot whose amounts are derived from `day`, so a wrong slot is visible.
    fn summary(day: u32) -> DaySummary {
        DaySummary {
            day,
            outcome: Outcome::Idle,
            goal: 0,
            count: day % 7,
            streak_after: 0,
            per_share: U128(0),
            hero: None,
            jackpot: U128(0),
            pot_burned: U128(0),
            stake_slashed: U128(0),
            pot_after: U128(u128::from(day) * 10),
        }
    }

    fn days(history: &[DaySummary]) -> Vec<u32> {
        history.iter().map(|s| s.day).collect()
    }

    /// Block time exactly `ns` (finer than `set_time`'s seconds), storage kept.
    fn set_timestamp_ns(ns: u64) {
        let ctx = VMContextBuilder::new()
            .current_account_id(contract_id())
            .block_timestamp(ns)
            .storage_usage(env::storage_usage())
            .build();
        testing_env!(ctx);
    }

    // ---- get_config ----

    #[test]
    fn get_config_fresh_demo() {
        let c = setup("demo");
        let v = get_config(&c);
        assert_eq!(v.config, params("demo").config);
        assert_eq!(v.config.day_length_s, 60);
        assert_eq!(v.config.inactive_days, 3);
        assert_eq!(v.config.join_stake, U128(STAKE));
        assert_eq!(v.pot_bps, 5000);
        assert_eq!(v.faucet_bps, 100);
        assert_eq!(v.initial_supply, U128(SUPPLY));
        assert_eq!(v.launch_ns, U64(LAUNCH_NS));
        assert_eq!(v.auto_settle_cap, 50);
        assert_eq!(v.max_settle_days, 500);
        assert_eq!(v.history_len, 64);
    }

    #[test]
    fn get_config_fresh_mainnet() {
        let c = setup("mainnet");
        let v = get_config(&c);
        assert_eq!(v.config.day_length_s, 86_400);
        assert_eq!(v.config.warmup_days, 2);
        assert_eq!(v.config.faucet_amount, U128(0));
        assert_eq!(v.faucet_bps, 0);
        assert_eq!(v.initial_supply, U128(SUPPLY));
        // `initial_supply` stays fixed while the token supply shrinks.
        let mut c = c;
        ft::burn_from_contract(&mut c.token, 5);
        assert_eq!(get_config(&c).initial_supply, U128(SUPPLY));
    }

    // ---- get_state ----

    #[test]
    fn get_state_fresh() {
        let c = setup("demo");
        let v = get_state(&c);
        assert_eq!(
            v,
            StateView {
                today: 0,
                last_settled: None,
                pending_days: 0,
                // 10^27 × 5000 / 10^4 and 10^27 × 100 / 10^4.
                pot: U128(500_000_000_000_000_000_000_000_000),
                reserved: U128(0),
                stake_pool: U128(0),
                faucet_left: U128(10_000_000_000_000_000_000_000_000),
                jackpot_pending: U128(0),
                pending_hero_days: vec![],
                streak: 0,
                longest_streak: 0,
                active_count: 0,
                active_stake: U128(0),
                members_total: 0,
                total_supply: U128(SUPPLY),
                total_burned: U128(0),
                total_rewarded: U128(0),
                total_jackpots: U128(0),
                ms_to_day_end: 60_000,
            }
        );
    }

    #[test]
    fn get_state_reads_every_field() {
        let mut c = setup("demo");
        c.pot = 11;
        c.reserved = 12;
        c.stake_pool = 13;
        c.faucet_left = 14;
        c.jackpot_pending = 15;
        c.pending_heroes = vec![
            PendingHero {
                day: 7,
                closers: vec![alice()],
                jackpot: 5,
            },
            PendingHero {
                day: 9,
                closers: vec![bob(), carol()],
                jackpot: 10,
            },
        ];
        c.streak = 3;
        c.longest_streak = 8;
        c.active_count = 4;
        c.active_stake = 16;
        c.members_total = 6;
        c.total_burned = 17;
        c.total_rewarded = 18;
        c.total_jackpots = 19;
        c.last_settled = Some(7);
        ft::burn_from_contract(&mut c.token, 1_000);
        // Day 10, 15 s in: 2 days pending (8, 9), 45 s left.
        set_time(10, 15);
        assert_eq!(
            get_state(&c),
            StateView {
                today: 10,
                last_settled: Some(7),
                pending_days: 2,
                pot: U128(11),
                reserved: U128(12),
                stake_pool: U128(13),
                faucet_left: U128(14),
                jackpot_pending: U128(15),
                pending_hero_days: vec![7, 9],
                streak: 3,
                longest_streak: 8,
                active_count: 4,
                active_stake: U128(16),
                members_total: 6,
                total_supply: U128(SUPPLY - 1_000),
                total_burned: U128(17),
                total_rewarded: U128(18),
                total_jackpots: U128(19),
                ms_to_day_end: 45_000,
            }
        );
    }

    #[test]
    fn ms_to_day_end_at_day_boundaries() {
        let c = setup("demo");
        const DAY_NS: u64 = 60_000_000_000;
        let at = |ns: u64| {
            set_timestamp_ns(ns);
            let v = get_state(&c);
            (v.today, v.ms_to_day_end)
        };
        // First nanosecond of day 0: the whole day is left.
        assert_eq!(at(LAUNCH_NS), (0, 60_000));
        // 1 ns in: 59 999.999999 ms → rounded down.
        assert_eq!(at(LAUNCH_NS + 1), (0, 59_999));
        // Exactly 1 ms and 1.5 ms before the end.
        assert_eq!(at(LAUNCH_NS + DAY_NS - 1_000_000), (0, 1));
        assert_eq!(at(LAUNCH_NS + DAY_NS - 1_500_000), (0, 1));
        // Last nanosecond of day 0: less than 1 ms left → 0.
        assert_eq!(at(LAUNCH_NS + DAY_NS - 1), (0, 0));
        // First nanosecond of day 1: a full day again.
        assert_eq!(at(LAUNCH_NS + DAY_NS), (1, 60_000));
        // Day 1000, 59.999 s in.
        assert_eq!(at(LAUNCH_NS + 1000 * DAY_NS + 59_999_000_000), (1000, 1));
        // Whole seconds through the harness: day 3, 59 s in.
        set_time(3, 59);
        assert_eq!(get_state(&c).ms_to_day_end, 1_000);
    }

    #[test]
    fn ms_to_day_end_mainnet_day_length() {
        let c = setup("mainnet");
        // Day 2, 1 h in: 23 h left.
        set_time(2, 3_600);
        let v = get_state(&c);
        assert_eq!(v.today, 2);
        assert_eq!(v.ms_to_day_end, 23 * 3_600 * 1_000);
    }

    // ---- get_open_day ----

    #[test]
    fn get_open_day_fresh() {
        let c = setup("demo");
        assert_eq!(
            get_open_day(&c),
            OpenDayView {
                day: 0,
                goal: 0,
                count: 0,
                active: 0,
                forfeited: 0,
                closers: vec![],
                is_idle: true,
                stale: false,
            }
        );
        // Day 0 is still open on day 1: stale.
        set_time(1, 0);
        assert!(get_open_day(&c).stale);
    }

    #[test]
    fn get_open_day_reads_fields_and_stale() {
        let mut c = setup("demo");
        c.last_settled = Some(2);
        c.open = OpenDay {
            day: 3,
            goal: 4,
            active: 6,
            active_stake: 6 * STAKE,
            count: 2,
            checked_stake: 2 * STAKE,
            forfeited: 1,
            closers: vec![alice(), bob()],
            closer_height: 77,
        };
        set_time(3, 59);
        let expected = OpenDayView {
            day: 3,
            goal: 4,
            count: 2,
            active: 6,
            forfeited: 1,
            closers: vec![alice(), bob()],
            is_idle: false,
            stale: false,
        };
        assert_eq!(get_open_day(&c), expected);
        set_time(4, 0);
        assert_eq!(
            get_open_day(&c),
            OpenDayView {
                stale: true,
                ..expected
            }
        );
    }

    // ---- get_history ----

    #[test]
    fn get_history_empty_before_first_settle() {
        let mut c = setup("demo");
        assert!(get_history(&c, 64).is_empty());
        // Even with a stray slot: nothing is settled yet.
        c.history.insert(0, summary(0));
        assert!(get_history(&c, 64).is_empty());
    }

    #[test]
    fn get_history_partial_ring_newest_first() {
        let mut c = setup("demo");
        for d in 0..=4 {
            c.history.insert(d % HISTORY_LEN, summary(d));
        }
        c.last_settled = Some(4);
        let all = get_history(&c, 10);
        assert_eq!(days(&all), vec![4, 3, 2, 1, 0]);
        assert_eq!(all[0], summary(4));
        assert_eq!(all[4].pot_after, U128(0));
        assert_eq!(days(&get_history(&c, 2)), vec![4, 3]);
        assert_eq!(days(&get_history(&c, 1)), vec![4]);
        assert!(get_history(&c, 0).is_empty());
        assert_eq!(days(&get_history(&c, u32::MAX)), vec![4, 3, 2, 1, 0]);
    }

    #[test]
    fn get_history_single_day_zero() {
        let mut c = setup("demo");
        c.history.insert(0, summary(0));
        c.last_settled = Some(0);
        assert_eq!(get_history(&c, 64), vec![summary(0)]);
    }

    #[test]
    fn get_history_more_than_64_days() {
        let mut c = setup("demo");
        // Days 0..=99 written in order: the ring keeps 36..=99.
        for d in 0..100 {
            c.history.insert(d % HISTORY_LEN, summary(d));
        }
        c.last_settled = Some(99);
        let expected: Vec<u32> = (36..=99).rev().collect();
        for limit in [64, 65, 1_000, u32::MAX] {
            let h = get_history(&c, limit);
            assert_eq!(h.len(), 64);
            assert_eq!(days(&h), expected);
            assert_eq!(h[0], summary(99));
            assert_eq!(h[63], summary(36));
        }
        assert_eq!(days(&get_history(&c, 3)), vec![99, 98, 97]);
    }

    #[test]
    fn get_history_skips_foreign_and_missing_slots() {
        let mut c = setup("demo");
        for d in 7..=70 {
            c.history.insert(d % HISTORY_LEN, summary(d));
        }
        // Slot of day 68 holds day 4 (an older day); slot of day 69 is missing.
        c.history.insert(68 % HISTORY_LEN, summary(4));
        c.history.remove(&(69 % HISTORY_LEN));
        c.last_settled = Some(70);
        let h = get_history(&c, 64);
        let expected: Vec<u32> = (7..=70).rev().filter(|d| *d != 68 && *d != 69).collect();
        assert_eq!(h.len(), 62);
        assert_eq!(days(&h), expected);
        // The window is counted in days, not in returned items: 3 days back from 70 → only 70.
        assert_eq!(days(&get_history(&c, 3)), vec![70]);
        // A slot holding a newer day than its position (day 72 in the slot of day 8) is foreign too.
        c.history.insert(8, summary(72));
        assert!(!days(&get_history(&c, 64)).contains(&8));
        assert!(!days(&get_history(&c, 64)).contains(&72));
    }

    // ---- get_member ----

    #[test]
    fn get_member_unknown_is_none() {
        let mut c = setup("demo");
        assert_eq!(get_member(&c, alice()), None);
        c.members.insert(bob(), member(1, None));
        assert_eq!(get_member(&c, alice()), None);
        assert!(get_member(&c, bob()).is_some());
    }

    #[test]
    fn get_member_in_warmup() {
        let mut c = setup("demo");
        let key: PublicKey = KEY.parse().unwrap();
        let mut m = member(1, None);
        m.checkin_key = Some(key.clone());
        c.members.insert(alice(), m);
        let v = get_member(&c, alice()).unwrap();
        assert_eq!(
            v,
            MemberView {
                stake: U128(STAKE),
                join_day: 0,
                activation_day: 1,
                last_checkin: None,
                resolved_through: 1,
                claimable: U128(0),
                checkins: 0,
                personal_streak: 0,
                best_personal_streak: 0,
                hero_count: 0,
                storage_deposit: U128(STORAGE_DEPOSIT),
                checkin_key: Some(key),
                effective_stake: U128(STAKE),
                pending_claimable: U128(0),
                is_active: false,
                can_check_in_today: false,
                checked_in_today: false,
                kickable_from_day: None,
                current_personal_streak: 0,
            }
        );
        // The activation day itself: active, can check in, kickable from 1 + 3.
        set_time(1, 0);
        let v = get_member(&c, alice()).unwrap();
        assert!(v.is_active);
        assert!(v.can_check_in_today);
        assert_eq!(v.kickable_from_day, Some(4));
    }

    #[test]
    fn get_member_active_applies_settled_fails_and_reward() {
        let mut c = setup("demo");
        // Days 0..=3 settled; day 2 failed; day 1 succeeded with a share of 7.
        c.last_settled = Some(3);
        c.open.day = 4;
        bits::set(&mut c.failed_bits, 2);
        c.rewards.insert(
            1,
            DayReward {
                per_share: 7,
                refs: 1,
            },
        );
        let mut m = member(1, Some(1));
        m.claimable = 5;
        m.checkins = 1;
        m.personal_streak = 1;
        m.best_personal_streak = 4;
        m.hero_count = 2;
        c.members.insert(alice(), m);
        set_time(4, 0);

        let v = get_member(&c, alice()).unwrap();
        // Stored fields are reported as stored.
        assert_eq!(v.stake, U128(STAKE));
        assert_eq!(v.claimable, U128(5));
        assert_eq!(v.resolved_through, 1);
        assert_eq!(v.best_personal_streak, 4);
        assert_eq!(v.hero_count, 2);
        // One slash (day 2): 10^21 × 9000 / 10^4.
        assert_eq!(v.effective_stake, U128(900_000_000_000_000_000_000));
        // 5 + the day-1 share.
        assert_eq!(v.pending_claimable, U128(12));
        assert!(v.is_active);
        assert!(v.can_check_in_today);
        assert!(!v.checked_in_today);
        // since = 1 + 1, + inactive_days 3.
        assert_eq!(v.kickable_from_day, Some(5));
        // Last check-in on day 1 < today − 1 = 3: the streak is broken.
        assert_eq!(v.current_personal_streak, 0);
        // The view wrote nothing.
        let stored = c.members.get(&alice()).unwrap();
        assert_eq!(stored.stake, STAKE);
        assert_eq!(stored.resolved_through, 1);
        assert_eq!(c.rewards.get(&1).map(|r| r.refs), Some(1));
    }

    #[test]
    fn get_member_uses_settled_days_only() {
        let mut c = setup("demo");
        // Days 0, 1 settled (day 1 failed); today is 4, days 2 and 3 are pending. The bit of day 2
        // and the reward of day 2 are planted to show that unsettled days are not applied.
        c.last_settled = Some(1);
        c.open.day = 2;
        bits::set(&mut c.failed_bits, 1);
        bits::set(&mut c.failed_bits, 2);
        c.rewards.insert(
            2,
            DayReward {
                per_share: 7,
                refs: 1,
            },
        );
        c.members.insert(bob(), member(1, None));
        let mut a = member(1, Some(2));
        a.personal_streak = 2;
        c.members.insert(alice(), a);
        set_time(4, 0);

        let b = get_member(&c, bob()).unwrap();
        // Only day 1 counts: one slash, not two.
        assert_eq!(b.effective_stake, U128(900_000_000_000_000_000_000));
        let a = get_member(&c, alice()).unwrap();
        // Day 1 failed and alice did not check in on it; the day-2 share is not credited yet.
        assert_eq!(a.effective_stake, U128(900_000_000_000_000_000_000));
        assert_eq!(a.pending_claimable, U128(0));
        // Checked in on day 2 (the stale open day), not today (4).
        assert!(!a.checked_in_today);
        assert!(a.can_check_in_today);
        assert_eq!(a.current_personal_streak, 0);
        assert_eq!(a.kickable_from_day, Some(6));
    }

    #[test]
    fn get_member_streak_yesterday_and_today() {
        let mut c = setup("demo");
        c.last_settled = Some(4);
        c.open.day = 5;
        let mut m = member(1, Some(4));
        m.personal_streak = 3;
        m.best_personal_streak = 3;
        c.members.insert(alice(), m);
        set_time(5, 0);

        // Checked in yesterday: the streak is alive, today is still open.
        let v = get_member(&c, alice()).unwrap();
        assert_eq!(v.current_personal_streak, 3);
        assert!(!v.checked_in_today);
        assert!(v.can_check_in_today);
        assert_eq!(v.kickable_from_day, Some(8));

        // Checked in today.
        let m = c.members.get_mut(&alice()).unwrap();
        m.last_checkin = Some(5);
        m.personal_streak = 4;
        m.best_personal_streak = 4;
        let v = get_member(&c, alice()).unwrap();
        assert_eq!(v.current_personal_streak, 4);
        assert_eq!(v.personal_streak, 4);
        assert!(v.checked_in_today);
        assert!(!v.can_check_in_today);
        assert_eq!(v.kickable_from_day, Some(9));

        // Two days later: last check-in 5 < 7 − 1.
        set_time(7, 0);
        let v = get_member(&c, alice()).unwrap();
        assert_eq!(v.current_personal_streak, 0);
        assert_eq!(v.personal_streak, 4);
        // Day 6 (= today − 1) would still count.
        set_time(6, 0);
        assert_eq!(get_member(&c, alice()).unwrap().current_personal_streak, 4);
    }

    #[test]
    fn get_member_streak_on_day_zero() {
        let mut c = setup("demo");
        // Only reachable with warmup 0, which S3 forbids; the view still must not underflow.
        let mut m = member(0, Some(0));
        m.personal_streak = 1;
        c.members.insert(alice(), m);
        let v = get_member(&c, alice()).unwrap();
        assert_eq!(v.current_personal_streak, 1);
        assert!(v.checked_in_today);
    }

    // ---- get_kickable ----

    /// Members in index order 0..=5 on day 10 (demo: inactive_days 3).
    fn kickable_fixture() -> Contract {
        let mut c = setup("demo");
        c.last_settled = Some(9);
        c.open.day = 10;
        // 0: never checked in, active since 1 → kickable from 4.
        c.members.insert(alice(), member(1, None));
        // 1: checked in on 8 → kickable from 12.
        c.members.insert(bob(), member(1, Some(8)));
        // 2: warmup (activates on 11).
        c.members.insert(carol(), member(11, None));
        // 3: checked in on 6 → kickable from 10 = today (boundary).
        c.members.insert(dave(), member(1, Some(6)));
        // 4: checked in on 7 → kickable from 11 = today + 1.
        c.members.insert(eve(), member(1, Some(7)));
        // 5: activated today → kickable from 13.
        c.members.insert(frank(), member(10, None));
        set_time(10, 30);
        c
    }

    fn page(accounts: Vec<AccountId>, next_index: Option<u32>) -> KickablePage {
        KickablePage {
            accounts,
            next_index,
        }
    }

    #[test]
    fn get_kickable_fresh_is_empty() {
        let c = setup("demo");
        assert_eq!(get_kickable(&c, 0, 10), page(vec![], None));
        assert_eq!(get_kickable(&c, 5, 10), page(vec![], None));
    }

    #[test]
    fn get_kickable_filters_whole_set() {
        let c = kickable_fixture();
        assert_eq!(get_kickable(&c, 0, 6), page(vec![alice(), dave()], None));
        assert_eq!(get_kickable(&c, 0, 100), page(vec![alice(), dave()], None));
        // The flags agree with get_member.
        for (account, kickable) in [
            (alice(), true),
            (bob(), false),
            (carol(), false),
            (dave(), true),
            (eve(), false),
            (frank(), false),
        ] {
            let v = get_member(&c, account.clone()).unwrap();
            let now = v.kickable_from_day.is_some_and(|k| 10 >= k);
            assert_eq!(now, kickable, "{account}");
        }
    }

    #[test]
    fn get_kickable_pages() {
        let c = kickable_fixture();
        assert_eq!(get_kickable(&c, 0, 2), page(vec![alice()], Some(2)));
        // Empty page while more members follow.
        assert_eq!(get_kickable(&c, 1, 1), page(vec![], Some(2)));
        assert_eq!(get_kickable(&c, 1, 2), page(vec![], Some(3)));
        assert_eq!(get_kickable(&c, 2, 2), page(vec![dave()], Some(4)));
        assert_eq!(get_kickable(&c, 4, 1), page(vec![], Some(5)));
        // Last page: the window reaches the end exactly or beyond.
        assert_eq!(get_kickable(&c, 4, 2), page(vec![], None));
        assert_eq!(get_kickable(&c, 3, 3), page(vec![dave()], None));
        assert_eq!(get_kickable(&c, 5, 10), page(vec![], None));
        // Past the end.
        assert_eq!(get_kickable(&c, 6, 1), page(vec![], None));
        assert_eq!(get_kickable(&c, 100, 5), page(vec![], None));
        // No overflow at the u32 edge.
        assert_eq!(get_kickable(&c, u32::MAX, u32::MAX), page(vec![], None));
        assert_eq!(
            get_kickable(&c, 0, u32::MAX),
            page(vec![alice(), dave()], None)
        );
    }

    #[test]
    fn get_kickable_limit_zero_is_empty() {
        let c = kickable_fixture();
        assert_eq!(get_kickable(&c, 0, 0), page(vec![], None));
        assert_eq!(get_kickable(&c, 3, 0), page(vec![], None));
    }

    #[test]
    fn get_kickable_follows_today() {
        let c = kickable_fixture();
        // Kickable from: alice 4, dave 10, eve 11, bob 12, frank 13, carol 14 (activates on 11).
        set_time(3, 0);
        assert_eq!(get_kickable(&c, 0, 6), page(vec![], None));
        set_time(11, 0);
        assert_eq!(
            get_kickable(&c, 0, 6),
            page(vec![alice(), dave(), eve()], None)
        );
        set_time(13, 0);
        assert_eq!(
            get_kickable(&c, 0, 6),
            page(vec![alice(), bob(), dave(), eve(), frank()], None)
        );
        set_time(14, 0);
        assert_eq!(
            get_kickable(&c, 0, 6),
            page(vec![alice(), bob(), carol(), dave(), eve(), frank()], None)
        );
    }

    #[test]
    fn get_kickable_index_order_after_remove() {
        let mut c = kickable_fixture();
        // IterableMap::remove swaps the last member into the hole: frank moves to index 0.
        c.members.remove(&alice());
        set_time(13, 0);
        assert_eq!(get_kickable(&c, 0, 1), page(vec![frank()], Some(1)));
        assert_eq!(
            get_kickable(&c, 1, 10),
            page(vec![bob(), dave(), eve()], None)
        );
    }

    // ---- End to end with join / check_in / settle / claim (C5, C6) ----

    /// Demo set, alice, bob and carol joined on day 0 (active from day 1, goal 3).
    fn three_members() -> Contract {
        let mut c = setup("demo");
        for a in [alice(), bob(), carol()] {
            register_and_fund(&mut c, &a, STAKE);
            context(&a, near_sdk::NearToken::from_yoctonear(STORAGE_DEPOSIT));
            c.join(None);
        }
        c
    }

    fn check_in_as(c: &mut Contract, a: &AccountId, height: u64) {
        context(a, NO_DEPOSIT);
        set_height(height);
        c.check_in();
    }

    #[test]
    fn e2e_pending_claimable_equals_claim() {
        let mut c = three_members();
        set_time(1, 0);
        check_in_as(&mut c, &alice(), 10);
        check_in_as(&mut c, &bob(), 11);
        check_in_as(&mut c, &carol(), 12);
        assert_eq!(get_open_day(&c).count, 3);
        assert_eq!(get_open_day(&c).goal, 3);
        let a = get_member(&c, alice()).unwrap();
        assert!(a.checked_in_today);
        assert_eq!(a.current_personal_streak, 1);
        assert_eq!(a.pending_claimable, U128(0));

        // Day 2, day 1 not settled yet: the view counts settled days only.
        set_time(2, 0);
        assert_eq!(get_state(&c).pending_days, 1);
        assert_eq!(get_member(&c, alice()).unwrap().pending_claimable, U128(0));

        // Settle day 1: success, streak 1, mult 11 000, budget = 5·10^26 × 100 × 11 000 / 10^8
        // = 5.5·10^24, per_share = budget / (3 + 10).
        context(&dave(), NO_DEPOSIT);
        assert_eq!(c.settle(None), 1);
        const PER_SHARE: u128 = 423_076_923_076_923_076_923_076;
        let s = get_state(&c);
        assert_eq!(s.streak, 1);
        assert_eq!(s.pending_days, 0);
        assert_eq!(s.reserved, U128(3 * PER_SHARE));
        assert_eq!(s.jackpot_pending, U128(10 * PER_SHARE));
        assert_eq!(s.pending_hero_days, vec![1]);
        let h = get_history(&c, 64);
        assert_eq!(days(&h), vec![1, 0]);
        assert_eq!(h[0].outcome, Outcome::Success);
        assert_eq!(h[0].per_share, U128(PER_SHARE));

        for a in [alice(), bob(), carol()] {
            let v = get_member(&c, a.clone()).unwrap();
            assert_eq!(v.pending_claimable, U128(PER_SHARE), "{a}");
            assert_eq!(v.effective_stake, U128(STAKE), "{a}");
            // Yesterday's check-in keeps the streak alive.
            assert_eq!(v.current_personal_streak, 1, "{a}");
            context(&a, ONE_YOCTO);
            assert_eq!(c.claim(), v.pending_claimable, "{a}");
            assert_eq!(get_member(&c, a).unwrap().pending_claimable, U128(0));
        }
        assert_eq!(get_state(&c).reserved, U128(0));
    }

    #[test]
    fn e2e_effective_stake_after_fails() {
        let mut c = three_members();
        // Days 1 and 2: only alice checks in → both fail (goal 3).
        set_time(1, 0);
        check_in_as(&mut c, &alice(), 10);
        set_time(2, 0);
        check_in_as(&mut c, &alice(), 20);
        set_time(3, 0);
        context(&dave(), NO_DEPOSIT);
        assert_eq!(c.settle(None), 1);

        // bob and carol: two slashes, 10^21 × 0.9 × 0.9; nothing written to their records.
        for a in [bob(), carol()] {
            let v = get_member(&c, a.clone()).unwrap();
            assert_eq!(v.effective_stake, U128(810_000_000_000_000_000_000), "{a}");
            assert_eq!(v.stake, U128(STAKE), "{a}");
            assert_eq!(v.resolved_through, 1, "{a}");
            assert_eq!(v.kickable_from_day, Some(4), "{a}");
            assert_eq!(v.current_personal_streak, 0, "{a}");
        }
        let a = get_member(&c, alice()).unwrap();
        assert_eq!(a.effective_stake, U128(STAKE));
        assert_eq!(a.current_personal_streak, 2);
        assert_eq!(a.kickable_from_day, Some(6));

        // Aggregates: slash day 1 = 2·10^21 × 0.1, day 2 = 1.8·10^21 × 0.1 → active_stake
        // 2.62·10^21 = Σ effective_stake (no dust at these amounts).
        let s = get_state(&c);
        assert_eq!(s.streak, 0);
        assert_eq!(s.last_settled, Some(2));
        assert_eq!(s.active_count, 3);
        assert_eq!(s.active_stake, U128(2_620_000_000_000_000_000_000));
        assert_eq!(s.stake_pool, U128(2_620_000_000_000_000_000_000));
        // Pot burns 2.5·10^25 + 2.375·10^25 plus the slashes 3.8·10^20.
        assert_eq!(s.total_burned, U128(48_750_380_000_000_000_000_000_000));
        assert_eq!(s.total_supply, U128(951_249_620_000_000_000_000_000_000));
        assert_eq!(s.pot, U128(451_250_000_000_000_000_000_000_000));

        let h = get_history(&c, 64);
        assert_eq!(days(&h), vec![2, 1, 0]);
        assert_eq!(
            h.iter().map(|s| s.outcome).collect::<Vec<_>>(),
            vec![Outcome::Fail, Outcome::Fail, Outcome::Idle]
        );
        assert_eq!(h[0].stake_slashed, U128(180_000_000_000_000_000_000));
        assert_eq!(h[1].stake_slashed, U128(200_000_000_000_000_000_000));

        // Day 4 (pending day 3): bob and carol are kickable, alice is not.
        set_time(4, 0);
        assert_eq!(get_kickable(&c, 0, 10), page(vec![bob(), carol()], None));
        assert_eq!(get_kickable(&c, 0, 1), page(vec![], Some(1)));
        assert!(get_open_day(&c).stale);
        assert_eq!(get_member(&c, alice()).unwrap().current_personal_streak, 0);
    }
}
