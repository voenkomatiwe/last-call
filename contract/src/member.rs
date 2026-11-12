//! Members: join, resolve, claim, exit (leave/kick), check-in key (spec S9, S10, S13). Owner: C6.

use near_contract_standards::fungible_token::events::FtBurn;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, Promise, PublicKey, env, require};

use crate::config::BPS_BASE;
use crate::day::{auto_settle, today};
use crate::errors::{
    ERR_ALREADY_MEMBER, ERR_BAD_KEY, ERR_NOT_INACTIVE, ERR_NOT_MEMBER, ERR_NOTHING_TO_CLAIM,
    ERR_ONE_YOCTO, ERR_STORAGE_DEPOSIT,
};
use crate::types::{Member, ResolveDelta};
use crate::{Contract, bits, events, ft, math, nep413};

/// S13 `join`.
pub fn join(c: &mut Contract, checkin_key: Option<PublicKey>) {
    auto_settle(c);
    let today = today(c);
    let caller = env::predecessor_account_id();
    do_join(c, &caller, checkin_key, today);
}

/// S13 `set_checkin_key`: exactly 1 yocto (`ERR_ONE_YOCTO`), no auto-settle.
pub fn set_checkin_key(c: &mut Contract, key: Option<PublicKey>) {
    require_one_yocto();
    let caller = env::predecessor_account_id();
    let mut m = load(c, &caller);
    if let Some(key) = &key {
        require_ed25519(key);
    }
    m.checkin_key = key;
    c.members.insert(caller, m);
}

/// S13 `claim`: exactly 1 yocto; returns the claimed amount.
pub fn claim(c: &mut Contract) -> U128 {
    require_one_yocto();
    auto_settle(c);
    let today = today(c);
    let caller = env::predecessor_account_id();
    U128(do_claim(c, &caller, today))
}

/// S10 with kind Leave: exactly 1 yocto; returns `stake − fee` (S13).
pub fn leave(c: &mut Contract) -> U128 {
    require_one_yocto();
    auto_settle(c);
    let today = today(c);
    let caller = env::predecessor_account_id();
    let m = load(c, &caller);
    let out = exit(c, &caller, m, ExitKind::Leave, &caller, today);
    events::emit_leave(&caller, out.returned, out.burned);
    U128(out.returned)
}

/// S10 with kind Kick; returns the bounty (S13).
pub fn kick(c: &mut Contract, account_id: AccountId) -> U128 {
    auto_settle(c);
    let today = today(c);
    let caller = env::predecessor_account_id();
    let m = load(c, &account_id);
    require_kickable(&m, today, c.config.inactive_days);
    let out = exit(c, &account_id, m, ExitKind::Kick, &caller, today);
    events::emit_kick(&account_id, &caller, out.returned, out.burned, out.bounty);
    U128(out.bounty)
}

/// S9 without writing: what `resolve(m, t)` would apply (all days `< t` must be settled).
/// Used by `resolve` (C6) and by `get_member` with `t = next` (C7).
pub fn resolve_pure(c: &Contract, m: &Member, t: u32) -> ResolveDelta {
    // The share of the last check-in day `p`, once: `p ≥ resolved_through` means not credited yet.
    let mut claimable_add = 0;
    let mut reward_day = None;
    if let Some(p) = m.last_checkin
        && p < t
        && p >= m.resolved_through
        && let Some(reward) = c.rewards.get(&p)
    {
        claimable_add = reward.per_share;
        reward_day = Some(p);
    }

    // Failed days the member was active in and did not check in on.
    let from = m.resolved_through.max(m.activation_day);
    let mut n = bits::count(&c.failed_bits, from, t);
    if let Some(p) = m.last_checkin
        && from <= p
        && p < t
        && bits::is_set(&c.failed_bits, p)
    {
        // Bit p is counted in `[from, t)`, so `n ≥ 1` here.
        n -= 1;
    }

    ResolveDelta {
        stake: math::stake_after_slashes(m.stake, n, c.config.slash_bps),
        claimable_add,
        reward_day,
        resolved_through: t,
    }
}

/// S9 `resolve(a, t)`: `resolve_pure` written into `m` plus the `refs` decrement of the credited
/// reward day (the record is removed at 0, I10). `m` is a copy the caller writes back.
pub(crate) fn resolve(c: &mut Contract, m: &mut Member, t: u32) {
    let delta = resolve_pure(c, m, t);
    m.stake = delta.stake;
    m.claimable += delta.claimable_add;
    m.resolved_through = delta.resolved_through;
    if let Some(d) = delta.reward_day
        && let Some(reward) = c.rewards.get_mut(&d)
    {
        reward.refs -= 1;
        if reward.refs == 0 {
            c.rewards.remove(&d);
        }
    }
}

/// A copy of the member record of `account_id`; `ERR_NOT_MEMBER` if there is none.
pub(crate) fn load(c: &Contract, account_id: &AccountId) -> Member {
    c.members
        .get(account_id)
        .cloned()
        .unwrap_or_else(|| env::panic_str(ERR_NOT_MEMBER))
}

/// Our 1-yocto methods use `ERR_ONE_YOCTO`, not the standard `assert_one_yocto` (S13).
fn require_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        ERR_ONE_YOCTO
    );
}

/// Only ed25519 keys (S12): any other curve or length → `ERR_BAD_KEY`, before anything is stored.
fn require_ed25519(key: &PublicKey) {
    require!(nep413::ed25519_key_bytes(key).is_some(), ERR_BAD_KEY);
}

/// S13 `join` after the auto-settle (`today == open.day`).
fn do_join(c: &mut Contract, caller: &AccountId, checkin_key: Option<PublicKey>, today: u32) {
    require!(!c.members.contains_key(caller), ERR_ALREADY_MEMBER);
    // R9: the storage of this join is measured after the auto-settle. The collections below write
    // lazily (on flush), so the settle's pending changes to them are written first: otherwise they
    // would land inside the measured interval.
    c.members.flush();
    c.maturing.flush();
    let before = env::storage_usage();

    if let Some(key) = &checkin_key {
        require_ed25519(key);
    }
    let stake = c.config.join_stake.0;
    ft::transfer_to_contract(&mut c.token, caller, stake);
    c.stake_pool += stake;
    let activation_day = today + c.config.warmup_days;
    *c.maturing.entry(activation_day).or_insert(0) += 1;
    c.members_total += 1;
    let storage_deposit = c.config.member_storage_deposit.0;
    c.members.insert(
        caller.clone(),
        Member {
            stake,
            join_day: today,
            activation_day,
            last_checkin: None,
            resolved_through: activation_day,
            claimable: 0,
            checkins: 0,
            personal_streak: 0,
            best_personal_streak: 0,
            hero_count: 0,
            storage_deposit,
            checkin_key,
        },
    );

    c.members.flush();
    c.maturing.flush();
    // Only additions since `before`, so no underflow.
    let used = env::storage_usage() - before;
    require!(
        u128::from(used) * env::storage_byte_cost().as_yoctonear() <= storage_deposit,
        ERR_STORAGE_DEPOSIT
    );
    let attached = env::attached_deposit().as_yoctonear();
    require!(attached >= storage_deposit, ERR_STORAGE_DEPOSIT);
    let surplus = attached - storage_deposit;
    if surplus > 0 {
        Promise::new(caller.clone())
            .transfer(NearToken::from_yoctonear(surplus))
            .detach();
    }
    events::emit_join(caller, stake, activation_day);
}

/// S13 `claim` after the auto-settle: resolve, pay out all of `claimable`, `reserved −= claimable`.
fn do_claim(c: &mut Contract, caller: &AccountId, today: u32) -> u128 {
    let mut m = load(c, caller);
    resolve(c, &mut m, today);
    let amount = m.claimable;
    require!(amount > 0, ERR_NOTHING_TO_CLAIM);
    m.claimable = 0;
    c.reserved -= amount;
    c.members.insert(caller.clone(), m);
    ft::transfer_from_contract(&mut c.token, caller, amount, None);
    events::emit_claim(caller, amount);
    amount
}

/// S10 kick condition: active and `today ≥ since + inactive_days`, where `since` is the day after
/// the last check-in (or the activation day if there was none).
fn require_kickable(m: &Member, today: u32, inactive_days: u32) {
    let since = m.last_checkin.map_or(m.activation_day, |p| p + 1);
    let kickable_from_day = since + inactive_days;
    require!(
        m.activation_day <= today && today >= kickable_from_day,
        ERR_NOT_INACTIVE
    );
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitKind {
    Leave,
    Kick,
}

/// Amounts of one exit, for the return value and the `leave` / `kick` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExitOutcome {
    /// `stake − fee` (without `claimable`, S15).
    returned: u128,
    /// `fee − bounty`.
    burned: u128,
    bounty: u128,
}

/// S10 `exit(a, kind)` after the auto-settle (`today == open.day`). `m` is the current record of
/// `account_id`; `caller` receives the bounty of a kick.
fn exit(
    c: &mut Contract,
    account_id: &AccountId,
    mut m: Member,
    kind: ExitKind,
    caller: &AccountId,
    today: u32,
) -> ExitOutcome {
    resolve(c, &mut m, today);
    let b = c.config.slash_bps;
    let fee = if m.activation_day <= today {
        // Active.
        let checked = m.last_checkin == Some(today);
        let fee = if checked {
            0
        } else {
            math::leave_fee(m.stake, b)
        };
        c.active_count -= 1;
        // C5 of the patch: in `cargo test` this catches a broken I3.
        debug_assert!(c.active_stake >= m.stake && c.open.active_stake >= m.stake);
        // The base of the aggregate slash, not a bucket: dust may make it smaller than the stake.
        c.active_stake = c.active_stake.saturating_sub(m.stake);
        c.open.active_stake = c.open.active_stake.saturating_sub(m.stake);
        if checked {
            // R4: today's share of this member is not reserved at settle.
            c.open.checked_stake -= m.stake;
            c.open.forfeited += 1;
        }
        fee
    } else {
        // In warmup.
        let left = c.maturing.get(&m.activation_day).copied().unwrap_or(0) - 1;
        if left == 0 {
            c.maturing.remove(&m.activation_day);
        } else {
            c.maturing.insert(m.activation_day, left);
        }
        0
    };
    c.stake_pool -= m.stake;

    // R12: the bounty only to a caller registered in the token; otherwise all of the fee burns.
    let bounty = if kind == ExitKind::Kick && ft::is_registered(&c.token, caller) {
        fee * u128::from(c.config.kick_bounty_bps) / BPS_BASE
    } else {
        0
    };
    let burn = fee - bounty;
    if burn > 0 {
        ft::burn_from_contract(&mut c.token, burn);
        c.total_burned += burn;
        FtBurn {
            owner_id: &env::current_account_id(),
            amount: U128(burn),
            memo: None,
        }
        .emit();
    }
    ft::transfer_from_contract(&mut c.token, caller, bounty, None);

    c.reserved -= m.claimable;
    // A member cannot unregister from the token (S13), so the payout never fails.
    let payout = m.claimable + m.stake - fee;
    ft::transfer_from_contract(&mut c.token, account_id, payout, None);

    c.members_total -= 1;
    if c.members_total == 0 {
        // R11: dust to the pot, and no stale stake left in the open day.
        c.pot += c.stake_pool;
        c.stake_pool = 0;
        c.active_stake = 0;
        c.open.active_stake = 0;
        c.open.checked_stake = 0;
    }
    c.members.remove(account_id);
    if m.storage_deposit > 0 {
        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(m.storage_deposit))
            .detach();
    }

    ExitOutcome {
        returned: m.stake - fee,
        burned: burn,
        bounty,
    }
}

/// Helpers shared by the tests of `member` and `checkin`.
#[cfg(test)]
pub(crate) mod testkit {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use near_sdk::{AccountId, NearToken, PublicKey};

    use super::resolve_pure;
    use crate::Contract;
    use crate::test_utils::{context, contract_id, register_and_fund, set_height};
    use crate::types::CheckInResult;

    /// `member_storage_deposit` of every set in params.json: 10^22 yocto.
    pub const DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
    /// `join_stake` of the demo set: 10^21.
    pub const DEMO_STAKE: u128 = 1_000_000_000_000_000_000_000;

    pub fn yocto(amount: u128) -> NearToken {
        NearToken::from_yoctonear(amount)
    }

    pub fn ed25519_key() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .expect("valid ed25519 key")
    }

    /// Registers and funds `a` with exactly `join_stake`, then `join` with the exact deposit.
    pub fn join_as(c: &mut Contract, a: &AccountId, key: Option<PublicKey>) {
        let stake = c.config.join_stake.0;
        register_and_fund(c, a, stake);
        context(a, yocto(DEPOSIT));
        c.join(key);
    }

    /// `check_in()` by `a` in a block of height `h`.
    pub fn check_in_as(c: &mut Contract, a: &AccountId, h: u64) -> CheckInResult {
        context(a, yocto(0));
        set_height(h);
        c.check_in()
    }

    /// FT balance (0 if not registered).
    pub fn balance(c: &Contract, a: &AccountId) -> u128 {
        c.token.accounts.get(a).unwrap_or(0)
    }

    pub fn panic_message(f: impl FnOnce()) -> String {
        let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default()
    }

    /// `f` panics with `err`. Only for calls that fail before changing state (the unit-test
    /// runtime does not roll back).
    pub fn expect_err(err: &str, f: impl FnOnce()) {
        let message = panic_message(f);
        assert!(message.contains(err), "expected {err}, got {message:?}");
    }

    /// The invariants this task touches, checked by walking all members: I1, I3, I11, I12.
    pub fn check_invariants(c: &Contract) {
        let contract_balance = balance(c, &contract_id());
        assert_eq!(
            contract_balance,
            c.pot + c.reserved + c.stake_pool + c.faucet_left + c.jackpot_pending,
            "I1"
        );
        let next = c.open.day;
        let (mut all, mut active, mut active_count) = (0u128, 0u128, 0u32);
        for m in c.members.values() {
            let stake = resolve_pure(c, m, next).stake;
            all += stake;
            if m.activation_day <= next {
                active += stake;
                active_count += 1;
            }
        }
        assert!(
            all <= c.stake_pool,
            "I3: {all} > stake_pool {}",
            c.stake_pool
        );
        assert!(
            active <= c.active_stake,
            "I3: {active} > active_stake {}",
            c.active_stake
        );
        assert_eq!(active_count, c.active_count, "I11 active_count");
        assert_eq!(c.members.len(), c.members_total, "I11 members_total");
        assert!(c.open.checked_stake <= c.open.active_stake, "I12");
        assert!(c.open.active_stake <= c.active_stake, "I12");
        assert!(c.active_stake <= c.stake_pool, "I12");
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::FungibleTokenCore;
    use near_sdk::borsh;
    use near_sdk::json_types::U128;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::{Value, json};
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::{AccountId, PublicKey, env};

    use super::testkit::*;
    use super::*;
    use crate::config::MAX_MEMBER_BYTES;
    use crate::test_utils::{
        NO_DEPOSIT, ONE_YOCTO, alice, bob, carol, context, contract_id, dave, event_logs,
        register_and_fund, set_time, setup, user,
    };
    use crate::types::DayReward;

    /// 10^23: `join_stake` of the mainnet set.
    const MAINNET_STAKE: u128 = 100_000_000_000_000_000_000_000;
    /// Pot of every set after `new`: 10^27 × 5000 / 10^4.
    const POT0: u128 = 500_000_000_000_000_000_000_000_000;
    /// Demo, three members who all checked in on day 1 (the first active day, streak 0 → 1):
    /// budget = 5·10^26 × 100 × 11 000 / 10^8 = 5.5·10^24; per_share = ⌊5.5·10^24 / (3 + 10)⌋.
    const PER_SHARE_DAY1: u128 = 423_076_923_076_923_076_923_076;

    fn member(stake: u128, activation_day: u32) -> Member {
        Member {
            stake,
            join_day: activation_day - 1,
            activation_day,
            last_checkin: None,
            resolved_through: activation_day,
            claimable: 0,
            checkins: 0,
            personal_streak: 0,
            best_personal_streak: 0,
            hero_count: 0,
            storage_deposit: DEPOSIT,
            checkin_key: None,
        }
    }

    fn events_named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
        events.iter().filter(|e| e["event"] == name).collect()
    }

    fn transfer_receipts() -> Vec<(AccountId, u128)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let receiver = r.receiver_id.clone();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::Transfer { deposit, .. } => {
                        Some((receiver.clone(), deposit.as_yoctonear()))
                    }
                    _ => None,
                })
            })
            .collect()
    }

    /// alice, bob, carol join on day 0 (demo: active from day 1, goal 3) and all check in on day 1.
    fn three_checked_in_on_day1(c: &mut Contract) {
        for a in [alice(), bob(), carol()] {
            join_as(c, &a, None);
        }
        set_time(1, 0);
        check_in_as(c, &alice(), 10);
        check_in_as(c, &bob(), 11);
        check_in_as(c, &carol(), 12);
    }

    // ---- resolve (S9) on hand-filled failed_bits / rewards ----

    #[test]
    fn resolve_slashes_failed_days_from_activation() {
        let mut c = setup("demo");
        // Day 1 is before activation, day 7 is not < t.
        for d in [1, 2, 3, 5, 7] {
            bits::set(&mut c.failed_bits, d);
        }
        let m = member(DEMO_STAKE, 2);
        // Days 2, 3, 5: 10^21 × 0.9³.
        assert_eq!(
            resolve_pure(&c, &m, 7),
            ResolveDelta {
                stake: 729_000_000_000_000_000_000,
                claimable_add: 0,
                reward_day: None,
                resolved_through: 7,
            }
        );
        // From `resolved_through` when it is past the activation day: only day 5.
        let m = Member {
            resolved_through: 4,
            ..member(DEMO_STAKE, 2)
        };
        assert_eq!(resolve_pure(&c, &m, 7).stake, 900_000_000_000_000_000_000);
        // Nothing to apply: t == resolved_through.
        assert_eq!(resolve_pure(&c, &m, 4).stake, DEMO_STAKE);
    }

    #[test]
    fn resolve_skips_the_failed_day_of_the_own_check_in() {
        let mut c = setup("demo");
        for d in [3, 5] {
            bits::set(&mut c.failed_bits, d);
        }
        // Checked in on failed day 3 (resolve then set resolved_through = 3): only day 5 slashes.
        let m = Member {
            last_checkin: Some(3),
            resolved_through: 3,
            ..member(DEMO_STAKE, 2)
        };
        assert_eq!(resolve_pure(&c, &m, 7).stake, 900_000_000_000_000_000_000);
        // Day 3 not yet < t: neither counted nor skipped.
        assert_eq!(resolve_pure(&c, &m, 3).stake, DEMO_STAKE);
    }

    /// R1: 30 failures of a 10^23 stake. The first 23 slashes are exact (9^23), the 24th is not;
    /// after 30 the personal stake is below the aggregate (floor slash of the same 10^23).
    /// Expected values computed independently (Python big integers).
    #[test]
    fn resolve_r1_dust_personal_not_above_aggregate() {
        let mut c = setup("mainnet");
        for d in 2..32 {
            bits::set(&mut c.failed_bits, d);
        }
        let m = member(MAINNET_STAKE, 2);
        // 23 failures: 10^23 × 0.9^23 = 9^23 exactly.
        assert_eq!(
            resolve_pure(&c, &m, 25).stake,
            8_862_938_119_652_501_095_929
        );
        // 24: ⌊9^24 / 10⌋.
        assert_eq!(
            resolve_pure(&c, &m, 26).stake,
            7_976_644_307_687_250_986_336
        );
        let personal = resolve_pure(&c, &m, 32).stake;
        assert_eq!(personal, 4_239_115_827_521_620_351_427);
        // The aggregate of S8 for the same single unchecked stake: D −= ⌊D × b / B⌋.
        let mut aggregate = MAINNET_STAKE;
        for _ in 0..30 {
            aggregate -= math::aggregate_slash(aggregate, 0, c.config.slash_bps);
        }
        assert_eq!(aggregate, 4_239_115_827_521_620_351_432);
        assert!(personal <= aggregate);
    }

    /// The reward of the last check-in day is credited once; `refs` goes down per member and the
    /// record is removed at 0 (I10).
    #[test]
    fn resolve_credits_reward_once_and_removes_record_at_zero_refs() {
        let mut c = setup("demo");
        c.rewards.insert(
            5,
            DayReward {
                per_share: 7_000,
                refs: 2,
            },
        );
        let checked = Member {
            last_checkin: Some(5),
            resolved_through: 5,
            ..member(DEMO_STAKE, 2)
        };
        let (mut a, mut b) = (checked.clone(), checked);

        // Day 5 is not settled yet (t == 5): nothing.
        resolve(&mut c, &mut a, 5);
        assert_eq!(a.claimable, 0);
        assert_eq!(c.rewards.get(&5).map(|r| r.refs), Some(2));

        resolve(&mut c, &mut a, 6);
        assert_eq!((a.claimable, a.resolved_through), (7_000, 6));
        assert_eq!(c.rewards.get(&5).map(|r| r.refs), Some(1));
        // Again later: resolved_through 6 > 5, nothing more.
        assert_eq!(resolve_pure(&c, &a, 9).claimable_add, 0);
        resolve(&mut c, &mut a, 9);
        assert_eq!(a.claimable, 7_000);
        assert_eq!(c.rewards.get(&5).map(|r| r.refs), Some(1));

        let delta = resolve_pure(&c, &b, 8);
        assert_eq!((delta.claimable_add, delta.reward_day), (7_000, Some(5)));
        resolve(&mut c, &mut b, 8);
        assert_eq!(b.claimable, 7_000);
        assert!(c.rewards.get(&5).is_none());
    }

    // ---- join (S13) ----

    #[test]
    fn t02_join_moves_stake_and_refunds_surplus() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), DEMO_STAKE + 5);
        let contract_before = balance(&c, &contract_id());
        set_time(5, 0);
        context(&alice(), yocto(DEPOSIT + 3_000_000_000_000_000_000_000));
        c.join(Some(ed25519_key()));

        // The surplus 3·10^21 yocto goes back in one transfer receipt.
        assert_eq!(
            transfer_receipts(),
            vec![(alice(), 3_000_000_000_000_000_000_000)]
        );
        let events = event_logs();
        let transfers = events_named(&events, "ft_transfer");
        assert_eq!(transfers.len(), 1);
        assert_eq!(
            transfers[0]["data"],
            json!([{"old_owner_id": "alice.near", "new_owner_id": "lastcall.near",
                    "amount": "1000000000000000000000"}])
        );
        let joins = events_named(&events, "join");
        assert_eq!(joins.len(), 1);
        assert_eq!(
            joins[0]["data"],
            json!({"account_id": "alice.near", "stake": "1000000000000000000000",
                   "activation_day": 6})
        );

        assert_eq!(balance(&c, &alice()), 5);
        assert_eq!(balance(&c, &contract_id()), contract_before + DEMO_STAKE);
        assert_eq!(c.stake_pool, DEMO_STAKE);
        assert_eq!(c.members_total, 1);
        assert_eq!(c.maturing.get(&6).copied(), Some(1));
        assert_eq!(c.active_count, 0);
        assert_eq!(
            c.members.get(&alice()).cloned(),
            Some(Member {
                stake: DEMO_STAKE,
                join_day: 5,
                activation_day: 6,
                last_checkin: None,
                resolved_through: 6,
                claimable: 0,
                checkins: 0,
                personal_streak: 0,
                best_personal_streak: 0,
                hero_count: 0,
                storage_deposit: DEPOSIT,
                checkin_key: Some(ed25519_key()),
            })
        );
        check_invariants(&c);
    }

    #[test]
    fn t02_join_with_exact_deposit_refunds_nothing() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        assert!(get_created_receipts().is_empty());
        join_as(&mut c, &bob(), None);
        assert_eq!(c.maturing.get(&1).copied(), Some(2));
        assert_eq!(c.stake_pool, 2 * DEMO_STAKE);
    }

    #[test]
    #[should_panic(expected = "ERR_STORAGE_DEPOSIT")]
    fn t02_join_without_deposit() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), DEMO_STAKE);
        context(&alice(), NO_DEPOSIT);
        c.join(None);
    }

    #[test]
    #[should_panic(expected = "ERR_STORAGE_DEPOSIT")]
    fn t02_join_with_deposit_one_yocto_short() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), DEMO_STAKE);
        context(&alice(), yocto(DEPOSIT - 1));
        c.join(None);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_REGISTERED")]
    fn t02_join_unregistered() {
        let mut c = setup("demo");
        context(&alice(), yocto(DEPOSIT));
        c.join(None);
    }

    #[test]
    #[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
    fn t02_join_without_balance() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), DEMO_STAKE - 1);
        context(&alice(), yocto(DEPOSIT));
        c.join(None);
    }

    #[test]
    #[should_panic(expected = "ERR_ALREADY_MEMBER")]
    fn t02_join_twice() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        join_as(&mut c, &alice(), None);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_KEY")]
    fn t02_join_rejects_secp256k1_key() {
        let mut c = setup("demo");
        let mut bytes = vec![1u8];
        bytes.extend([7u8; 64]);
        let key = PublicKey::try_from(bytes).expect("secp256k1 key shape");
        join_as(&mut c, &alice(), Some(key));
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_KEY")]
    fn t02_join_rejects_ml_dsa_key() {
        let mut c = setup("demo");
        let mut bytes = vec![2u8];
        bytes.extend([7u8; 1952]);
        let key = PublicKey::try_from(bytes).expect("ml-dsa-65 key shape");
        join_as(&mut c, &alice(), Some(key));
    }

    /// The measured storage is checked against `member_storage_deposit` (R9).
    #[test]
    #[should_panic(expected = "ERR_STORAGE_DEPOSIT")]
    fn t02_join_storage_above_member_deposit() {
        let mut c = setup("demo");
        // 100 bytes' worth: far below one member record.
        let small = 100 * env::storage_byte_cost().as_yoctonear();
        c.config.member_storage_deposit = U128(small);
        register_and_fund(&mut c, &alice(), DEMO_STAKE);
        context(&alice(), yocto(small));
        c.join(None);
    }

    /// MAX_MEMBER_BYTES (S4): one join with a 64-character account id, an ed25519 key and a new
    /// `maturing` entry. Hand count (storage counts key + value + 40 bytes per record):
    /// - `members` value: key sha256 (32) + borsh(Member) 115 (stake 16, join_day 4,
    ///   activation_day 4, last_checkin None 1, resolved_through 4, claimable 16, four u32 16,
    ///   storage_deposit 16, Some(key) 1 + 4 + 33) + key_index 4 + 40 = 191;
    /// - `members` index (Vector): key [6, 'v', u32] 6 + borsh(AccountId) 4 + 64 + 40 = 114;
    /// - `maturing`: key [2, u32] 5 + u32 4 + 40 = 49.
    ///
    /// Total 354; the first check-in turns `last_checkin` into `Some` (+4) → 358.
    #[test]
    fn max_member_bytes_measured() {
        let mut c = setup("mainnet");
        let long: AccountId = "a".repeat(64).parse().expect("64-character account id");
        register_and_fund(&mut c, &long, MAINNET_STAKE);
        context(&long, yocto(DEPOSIT));
        let before = env::storage_usage();
        c.join(Some(ed25519_key()));
        let used = env::storage_usage() - before;
        assert_eq!(used, 354);

        let record = c.members.get(&long).cloned().expect("member");
        let grown = Member {
            last_checkin: Some(2),
            ..record.clone()
        };
        let growth = borsh::to_vec(&grown).expect("borsh").len()
            - borsh::to_vec(&record).expect("borsh").len();
        assert_eq!(growth, 4);
        let max_bytes = used + growth as u64;
        assert!(max_bytes <= MAX_MEMBER_BYTES);
        assert!(u128::from(max_bytes) * env::storage_byte_cost().as_yoctonear() <= DEPOSIT);
    }

    // ---- claim (S13) ----

    #[test]
    #[should_panic(expected = "ERR_NOTHING_TO_CLAIM")]
    fn t17_claim_without_rewards() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        set_time(1, 0);
        check_in_as(&mut c, &alice(), 5);
        context(&alice(), ONE_YOCTO);
        c.claim();
    }

    #[test]
    fn t17_claim_pays_once_then_nothing_to_claim() {
        let mut c = setup("demo");
        three_checked_in_on_day1(&mut c);
        set_time(2, 0);
        context(&alice(), ONE_YOCTO);
        let reserved_before_settle = c.reserved;
        assert_eq!(reserved_before_settle, 0);
        assert_eq!(c.claim(), U128(PER_SHARE_DAY1));
        let events = event_logs();
        assert_eq!(
            events_named(&events, "claim")[0]["data"],
            json!({"account_id": "alice.near", "amount": "423076923076923076923076"})
        );
        assert_eq!(balance(&c, &alice()), PER_SHARE_DAY1);
        // Day 1 reserved 3 shares; alice took one.
        assert_eq!(c.reserved, 2 * PER_SHARE_DAY1);
        assert_eq!(c.rewards.get(&1).map(|r| r.refs), Some(2));
        assert_eq!(c.members.get(&alice()).map(|m| m.claimable), Some(0));
        check_invariants(&c);

        context(&alice(), ONE_YOCTO);
        expect_err(ERR_NOTHING_TO_CLAIM, || {
            c.claim();
        });
        set_time(3, 0);
        context(&alice(), ONE_YOCTO);
        expect_err(ERR_NOTHING_TO_CLAIM, || {
            c.claim();
        });
    }

    #[test]
    #[should_panic(expected = "ERR_ONE_YOCTO")]
    fn t17_claim_requires_one_yocto() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        context(&alice(), yocto(2));
        c.claim();
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_MEMBER")]
    fn t17_claim_by_non_member() {
        let mut c = setup("demo");
        context(&alice(), ONE_YOCTO);
        c.claim();
    }

    /// 8: checked in on a failed day → not slashed for it; checked in on a successful day and back
    /// 10 days later → gets the share of that day.
    #[test]
    fn t08_checked_in_member_not_slashed_and_gets_share_later() {
        let mut c = setup("demo");
        for a in [alice(), bob(), carol()] {
            join_as(&mut c, &a, None);
        }
        set_time(1, 0);
        check_in_as(&mut c, &alice(), 10);
        // Day 2 settles day 1: Fail, slash ⌊(3·10^21 − 10^21) × 0.1⌋ = 2·10^20.
        set_time(2, 0);
        check_in_as(&mut c, &alice(), 20);
        assert!(bits::is_set(&c.failed_bits, 1));
        assert_eq!(c.active_stake, 2_800_000_000_000_000_000_000);
        assert_eq!(c.members.get(&alice()).map(|m| m.stake), Some(DEMO_STAKE));
        let bob_record = c.members.get(&bob()).cloned().expect("bob");
        assert_eq!(
            resolve_pure(&c, &bob_record, 2).stake,
            900_000_000_000_000_000_000
        );
        check_in_as(&mut c, &bob(), 21);
        check_in_as(&mut c, &carol(), 22);
        assert_eq!(c.open.checked_stake, 2_800_000_000_000_000_000_000);
        check_invariants(&c);

        // Day 12 settles day 2 (Success, streak 1, pot 4.75·10^26: per_share =
        // ⌊4.75·10^26 × 100 × 11 000 / 10^8 / 13⌋) and days 3..11 (Fail, nobody checked in).
        set_time(12, 0);
        context(&alice(), ONE_YOCTO);
        assert_eq!(c.claim(), U128(401_923_076_923_076_923_076_923));
        assert_eq!(c.rewards.get(&2).map(|r| r.refs), Some(2));
        // Nine failed days 3..11 while away: 10^21 × 0.9^9.
        assert_eq!(
            c.members.get(&alice()).map(|m| m.stake),
            Some(387_420_489_000_000_000_000)
        );
        check_invariants(&c);
    }

    // ---- leave (S10) ----

    #[test]
    fn t18_leave_in_warmup_returns_everything() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        join_as(&mut c, &bob(), None);
        let pot = c.pot;
        context(&alice(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(DEMO_STAKE));
        assert_eq!(transfer_receipts(), vec![(alice(), DEPOSIT)]);
        let events = event_logs();
        assert!(events_named(&events, "ft_burn").is_empty());
        assert_eq!(
            events_named(&events, "ft_transfer")[0]["data"],
            json!([{"old_owner_id": "lastcall.near", "new_owner_id": "alice.near",
                    "amount": "1000000000000000000000"}])
        );
        assert_eq!(
            events_named(&events, "leave")[0]["data"],
            json!({"account_id": "alice.near", "returned": "1000000000000000000000",
                   "fee_burned": "0"})
        );
        assert_eq!(balance(&c, &alice()), DEMO_STAKE);
        assert_eq!(c.maturing.get(&1).copied(), Some(1));
        assert_eq!(c.stake_pool, DEMO_STAKE);
        assert_eq!(c.members_total, 1);
        assert!(c.members.get(&alice()).is_none());
        assert_eq!(c.total_burned, 0);
        check_invariants(&c);

        context(&bob(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(DEMO_STAKE));
        assert!(c.maturing.get(&1).is_none());
        assert_eq!((c.stake_pool, c.members_total, c.pot), (0, 0, pot));
        check_invariants(&c);
    }

    /// R4: leaving after today's check-in costs no fee, and the share of that day is not reserved
    /// (`refs = count − 1`).
    #[test]
    fn t18_leave_after_check_in_forfeits_the_share() {
        let mut c = setup("demo");
        three_checked_in_on_day1(&mut c);
        context(&alice(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(DEMO_STAKE));
        assert!(events_named(&event_logs(), "ft_burn").is_empty());
        assert_eq!(c.open.forfeited, 1);
        assert_eq!(c.open.count, 3);
        assert_eq!(c.open.checked_stake, 2 * DEMO_STAKE);
        assert_eq!(c.open.active_stake, 2 * DEMO_STAKE);
        assert_eq!((c.active_count, c.active_stake), (2, 2 * DEMO_STAKE));
        assert_eq!(c.stake_pool, 2 * DEMO_STAKE);
        assert!(c.open.closers.contains(&alice()));
        check_invariants(&c);

        // Day 2 settles day 1: Success with 3 check-ins, 2 shares.
        set_time(2, 0);
        c.settle(None);
        assert_eq!(
            c.rewards.get(&1).copied(),
            Some(DayReward {
                per_share: PER_SHARE_DAY1,
                refs: 2,
            })
        );
        assert_eq!(c.reserved, 2 * PER_SHARE_DAY1);
        assert_eq!(c.pot, POT0 - 12 * PER_SHARE_DAY1);
        assert!(c.pending_heroes[0].closers.contains(&alice()));
        check_invariants(&c);
    }

    #[test]
    fn t18_leave_without_check_in_burns_the_fee() {
        let mut c = setup("demo");
        for a in [alice(), bob(), carol()] {
            join_as(&mut c, &a, None);
        }
        set_time(1, 0);
        let supply = c.ft_total_supply().0;
        context(&alice(), ONE_YOCTO);
        // fee = 10^21 × 10% = 10^20.
        assert_eq!(c.leave(), U128(900_000_000_000_000_000_000));
        let events = event_logs();
        let burns = events_named(&events, "ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(
            burns[0]["data"],
            json!([{"owner_id": "lastcall.near", "amount": "100000000000000000000"}])
        );
        assert_eq!(
            events_named(&events, "leave")[0]["data"],
            json!({"account_id": "alice.near", "returned": "900000000000000000000",
                   "fee_burned": "100000000000000000000"})
        );
        assert_eq!(c.total_burned, 100_000_000_000_000_000_000);
        assert_eq!(c.ft_total_supply().0, supply - 100_000_000_000_000_000_000);
        assert_eq!(balance(&c, &alice()), 900_000_000_000_000_000_000);
        assert_eq!((c.active_count, c.members_total), (2, 2));
        assert_eq!(c.active_stake, 2 * DEMO_STAKE);
        assert_eq!(c.open.active_stake, 2 * DEMO_STAKE);
        assert_eq!(c.stake_pool, 2 * DEMO_STAKE);
        assert_eq!(c.open.forfeited, 0);
        check_invariants(&c);
    }

    /// R11: 25 failed days leave 5 yocto of dust (Python: aggregate 215 369 396 307 555 776 633 vs
    /// 3 × 71 789 798 769 185 258 876); the last member moves it to the pot and zeroes `open.*`.
    #[test]
    fn t18_last_member_moves_dust_to_pot() {
        const S25: u128 = 71_789_798_769_185_258_876;
        const FEE25: u128 = 7_178_979_876_918_525_887;
        let mut c = setup("demo");
        for a in [alice(), bob(), carol()] {
            join_as(&mut c, &a, None);
        }
        // Days 1..25 fail (goal 3, nobody checks in).
        set_time(26, 0);
        context(&bob(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(S25 - FEE25));
        assert_eq!(c.active_stake, 215_369_396_307_555_776_633 - S25);
        context(&carol(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(S25 - FEE25));
        check_in_as(&mut c, &alice(), 30);
        check_invariants(&c);
        assert_eq!(c.stake_pool, S25 + 5);
        let pot = c.pot;

        context(&alice(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(S25));
        assert_eq!(c.pot, pot + 5);
        assert_eq!((c.stake_pool, c.active_stake), (0, 0));
        assert_eq!((c.open.active_stake, c.open.checked_stake), (0, 0));
        assert_eq!((c.members_total, c.active_count), (0, 0));
        assert_eq!(c.open.forfeited, 1);
        check_invariants(&c);

        // Day 26 settles Idle (no active members, R11) without panicking.
        set_time(27, 0);
        c.settle(None);
        assert_eq!(c.stake_pool, 0);
        check_invariants(&c);
    }

    #[test]
    #[should_panic(expected = "ERR_ONE_YOCTO")]
    fn t18_leave_requires_one_yocto() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        context(&alice(), NO_DEPOSIT);
        c.leave();
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_MEMBER")]
    fn t18_leave_by_non_member() {
        let mut c = setup("demo");
        context(&alice(), ONE_YOCTO);
        c.leave();
    }

    #[test]
    fn t19_leave_then_join_starts_a_new_warmup() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        set_time(1, 0);
        check_in_as(&mut c, &alice(), 5);
        set_time(2, 0);
        context(&alice(), ONE_YOCTO);
        // Single member: idle days, no slash; not checked in today → fee 10^20.
        assert_eq!(c.leave(), U128(900_000_000_000_000_000_000));
        // Top up to join_stake and join again.
        register_and_fund(&mut c, &alice(), 100_000_000_000_000_000_000);
        context(&alice(), yocto(DEPOSIT));
        c.join(None);
        let m = c.members.get(&alice()).cloned().expect("member");
        assert_eq!(
            (m.join_day, m.activation_day, m.resolved_through),
            (2, 3, 3)
        );
        assert_eq!(
            (m.last_checkin, m.checkins, m.personal_streak),
            (None, 0, 0)
        );
        assert_eq!(c.maturing.get(&3).copied(), Some(1));
        assert_eq!(c.active_count, 0);
        context(&alice(), NO_DEPOSIT);
        expect_err(crate::errors::ERR_WARMUP, || {
            c.check_in();
        });
        set_time(3, 0);
        assert_eq!(check_in_as(&mut c, &alice(), 9).day, 3);
        assert_eq!(c.active_count, 1);
        check_invariants(&c);
    }

    // ---- kick (S10) ----

    #[test]
    #[should_panic(expected = "ERR_NOT_INACTIVE")]
    fn t24_kick_in_warmup() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        context(&bob(), NO_DEPOSIT);
        c.kick(alice());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_MEMBER")]
    fn t24_kick_non_member() {
        let mut c = setup("demo");
        context(&bob(), NO_DEPOSIT);
        c.kick(alice());
    }

    /// demo: inactive_days 3. Never checked in, active from day 1: kickable from day 4; after a
    /// check-in on day 4: kickable from day 8.
    #[test]
    fn t24_kick_before_the_deadline_fails() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        set_time(3, 0);
        context(&bob(), NO_DEPOSIT);
        expect_err(ERR_NOT_INACTIVE, || {
            c.kick(alice());
        });
        set_time(4, 0);
        check_in_as(&mut c, &alice(), 4);
        // Last second of day 7 (demo day: 60 s).
        set_time(7, 59);
        context(&bob(), NO_DEPOSIT);
        expect_err(ERR_NOT_INACTIVE, || {
            c.kick(alice());
        });
        set_time(8, 0);
        context(&bob(), NO_DEPOSIT);
        // bob is not registered: no bounty.
        assert_eq!(c.kick(alice()), U128(0));
        assert!(c.members.get(&alice()).is_none());
    }

    /// Six members (goal 4); user0 never checks in, user1..user4 do (days 1..3 succeed).
    /// On day 4 dave (registered) kicks user0: fee 10^20, bounty 2·10^19, burned 8·10^19.
    #[test]
    fn t24_kick_after_inactivity() {
        let mut c = setup("demo");
        for i in 0..6 {
            join_as(&mut c, &user(i), None);
        }
        let mut h = 10;
        for day in 1..=3 {
            set_time(day, 0);
            for i in 1..=4 {
                h += 1;
                check_in_as(&mut c, &user(i), h);
            }
        }
        assert_eq!(c.open.goal, 4);
        register_and_fund(&mut c, &dave(), 0);
        set_time(4, 0);
        context(&dave(), NO_DEPOSIT);
        assert_eq!(c.kick(user(0)), U128(20_000_000_000_000_000_000));

        assert_eq!(transfer_receipts(), vec![(user(0), DEPOSIT)]);
        let events = event_logs();
        assert_eq!(
            events_named(&events, "ft_burn")[0]["data"],
            json!([{"owner_id": "lastcall.near", "amount": "80000000000000000000"}])
        );
        let transfers: Vec<&Value> = events_named(&events, "ft_transfer")
            .into_iter()
            .map(|e| &e["data"][0])
            .collect();
        assert_eq!(
            transfers,
            vec![
                &json!({"old_owner_id": "lastcall.near", "new_owner_id": "dave.near",
                        "amount": "20000000000000000000"}),
                &json!({"old_owner_id": "lastcall.near", "new_owner_id": "user0.near",
                        "amount": "900000000000000000000"}),
            ]
        );
        assert_eq!(
            events_named(&events, "kick")[0]["data"],
            json!({"account_id": "user0.near", "by": "dave.near",
                   "returned": "900000000000000000000", "fee_burned": "80000000000000000000",
                   "bounty": "20000000000000000000"})
        );
        assert_eq!(balance(&c, &dave()), 20_000_000_000_000_000_000);
        assert_eq!(balance(&c, &user(0)), 900_000_000_000_000_000_000);
        assert_eq!(c.total_burned, 80_000_000_000_000_000_000);
        assert_eq!((c.active_count, c.members_total), (5, 5));
        assert_eq!(c.active_stake, 5 * DEMO_STAKE);
        assert_eq!(c.open.active_stake, 5 * DEMO_STAKE);
        assert_eq!(c.stake_pool, 5 * DEMO_STAKE);
        // Today's goal stays; the next day opens with 5 active: max(3, ⌈5 × 0.6⌉) = 3.
        assert_eq!(c.open.goal, 4);
        check_invariants(&c);
        set_time(5, 0);
        c.settle(None);
        assert_eq!(c.open.goal, 3);
        check_invariants(&c);
    }

    /// Three members, nobody checks in: days 1..3 fail, alice's stake is 10^21 × 0.9³ = 7.29·10^20,
    /// fee 7.29·10^19 when kicked on day 4.
    fn three_members_inactive_until_day4(c: &mut Contract) {
        for a in [alice(), bob(), carol()] {
            join_as(c, &a, None);
        }
        set_time(4, 0);
        // Settle days 0..3 first, so the kick's logs hold only its own events.
        c.settle(None);
    }

    #[test]
    fn t30_kick_bounty_to_registered_caller() {
        let mut c = setup("demo");
        three_members_inactive_until_day4(&mut c);
        register_and_fund(&mut c, &dave(), 0);
        context(&dave(), NO_DEPOSIT);
        // bounty = 7.29·10^19 × 2000 / 10^4.
        assert_eq!(c.kick(alice()), U128(14_580_000_000_000_000_000));
        let events = event_logs();
        let burns = events_named(&events, "ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(
            burns[0]["data"],
            json!([{"owner_id": "lastcall.near", "amount": "58320000000000000000"}])
        );
        assert_eq!(balance(&c, &dave()), 14_580_000_000_000_000_000);
        assert_eq!(balance(&c, &alice()), 656_100_000_000_000_000_000);
        // Aggregate after 3 failures: 3·10^21 × 0.9³ = 2.187·10^21, minus alice.
        assert_eq!(c.active_stake, 1_458_000_000_000_000_000_000);
        check_invariants(&c);

        // 24: bob, in the same position, leaves: he gets what alice got. Had dave been alice's
        // second account, her self-kick would have paid the bounty on top (leave minus bounty).
        context(&bob(), ONE_YOCTO);
        assert_eq!(c.leave(), U128(656_100_000_000_000_000_000));
        assert_eq!(balance(&c, &bob()), balance(&c, &alice()));
        check_invariants(&c);
    }

    #[test]
    fn t30_kick_by_unregistered_caller_burns_the_whole_fee() {
        let mut c = setup("demo");
        three_members_inactive_until_day4(&mut c);
        let stranger: AccountId = "stranger.near".parse().expect("account id");
        let burned = c.total_burned;
        context(&stranger, NO_DEPOSIT);
        assert_eq!(c.kick(alice()), U128(0));
        let events = event_logs();
        let burns = events_named(&events, "ft_burn");
        assert_eq!(burns.len(), 1);
        assert_eq!(
            burns[0]["data"],
            json!([{"owner_id": "lastcall.near", "amount": "72900000000000000000"}])
        );
        assert_eq!(events_named(&events, "ft_transfer").len(), 1);
        assert_eq!(
            events_named(&events, "kick")[0]["data"]["fee_burned"],
            "72900000000000000000"
        );
        assert_eq!(c.total_burned, burned + 72_900_000_000_000_000_000);
        assert!(!ft::is_registered(&c.token, &stranger));
        assert_eq!(balance(&c, &alice()), 656_100_000_000_000_000_000);
        check_invariants(&c);
    }
}
