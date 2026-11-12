//! Hero draw in a separate receipt (spec S11, R10). Owner: C8.
//!
//! `settle_open_day` (C5) moves a successful day's jackpot from `pot` to `jackpot_pending`, pushes a
//! `PendingHero` and calls `schedule_pick_hero(day)`. The draw itself runs later, in its own receipt
//! (`pick_hero`), so the transaction that settled the day cannot condition on or roll back the
//! outcome.

use near_sdk::{Gas, NearToken, env, require};

use crate::config::{GAS_RESERVE, HISTORY_LEN, PICK_HERO_GAS};
use crate::errors::{ERR_LOW_GAS, ERR_NO_PENDING_HERO};
use crate::types::PendingHero;
use crate::{Contract, events, ft, math};

/// Gas that must be left when a `pick_hero` promise is scheduled: its static gas plus the reserve
/// for the rest of the call (S5).
const PICK_HERO_GAS_NEEDED: Gas = PICK_HERO_GAS.saturating_add(GAS_RESERVE);

/// `#[private]` in `lib.rs`. No auto-settle, no external calls, no branch that can panic.
pub fn pick_hero(c: &mut Contract, day: u32) {
    let Some(i) = c.pending_heroes.iter().position(|p| p.day == day) else {
        // Already drawn (a retry raced the original promise) or never pending: no-op.
        return;
    };
    // `i` comes from `position`, so it is in bounds.
    let PendingHero {
        closers, jackpot, ..
    } = c.pending_heroes.remove(i);

    // I13 holds, so `jackpot_pending ≥ jackpot`: the subtractions below cannot underflow.
    if closers.is_empty() {
        // Guard only: `math::hero_index` panics on an empty list, and settle never creates such a
        // record (S8). The jackpot goes back to the pot, no event.
        c.jackpot_pending -= jackpot;
        c.pot += jackpot;
        return;
    }

    let idx = math::hero_index(&env::random_seed_array(), day, closers.len());
    // `hero_index` returns `… % len`, so `idx < closers.len()`.
    let hero = &closers[idx];

    c.jackpot_pending -= jackpot;
    // `contains_key` instead of an assert: the hero may have unregistered from the token since
    // checking in (S10, S11); `transfer_from_contract` would panic on such a receiver.
    let paid = ft::is_registered(&c.token, hero);
    if paid {
        // A no-op for `jackpot == 0` (settle never creates such a record).
        ft::transfer_from_contract(&mut c.token, hero, jackpot, None);
        c.total_jackpots += jackpot;
        if let Some(member) = c.members.get_mut(hero) {
            member.hero_count += 1;
        }
    } else {
        c.pot += jackpot;
    }

    // The slot may already hold a later day (more than HISTORY_LEN days settled since): leave it.
    // `get` first, so that a foreign slot is not marked dirty and rewritten.
    let slot = day % HISTORY_LEN;
    if c.history.get(&slot).is_some_and(|s| s.day == day)
        && let Some(summary) = c.history.get_mut(&slot)
    {
        summary.hero = Some(hero.clone());
    }

    events::emit_hero(day, hero, jackpot, paid);
}

/// Anyone: `ERR_NO_PENDING_HERO`, `require_pick_hero_gas()`, then `schedule_pick_hero(day)`.
pub fn retry_pick_hero(c: &mut Contract, day: u32) {
    require!(
        c.pending_heroes.iter().any(|p| p.day == day),
        ERR_NO_PENDING_HERO
    );
    require_pick_hero_gas();
    schedule_pick_hero(day);
}

/// `prepaid_gas − used_gas ≥ PICK_HERO_GAS + GAS_RESERVE`, else `ERR_LOW_GAS` (S5, S11).
/// The only gas check for the hero promise: C5 (`settle`, `auto_settle`) and C8 (`retry_pick_hero`)
/// call this function.
pub fn require_pick_hero_gas() {
    // `used_gas ≤ prepaid_gas` in the runtime; saturating anyway, so the check itself never panics
    // on underflow.
    let left = env::prepaid_gas().saturating_sub(env::used_gas());
    require!(left >= PICK_HERO_GAS_NEEDED, ERR_LOW_GAS);
}

/// Promise to `current_account_id`: `pick_hero(day)`, static gas `PICK_HERO_GAS`, deposit 0, the
/// result is not awaited (S8, S11). The only place that creates it: C5 (`settle_open_day` via
/// `settle` / `auto_settle`) and C8 (`retry_pick_hero`) call this function.
///
/// near-sdk 5.30.1 builds a `Promise` lazily and emits it to the runtime in `Drop`
/// (`promise_batch_create` + `promise_batch_action_function_call_weight`); `detach()` just drops
/// it, so the receipt is created even though the calling method does not return the promise.
/// Static gas `PICK_HERO_GAS` is the guaranteed minimum (checked by `require_pick_hero_gas`).
/// Unused-gas weight 1: the code is immutable, so if `PICK_HERO_GAS` ever proves too small, a
/// `retry_pick_hero` with a large prepaid gas still gets the jackpot out (unused gas is refunded).
pub fn schedule_pick_hero(day: u32) {
    Contract::ext(env::current_account_id())
        .with_static_gas(PICK_HERO_GAS)
        .with_attached_deposit(NearToken::from_yoctonear(0))
        .with_unused_gas_weight(1)
        .pick_hero(day)
        .detach();
}

#[cfg(test)]
mod tests {
    use near_sdk::Gas;
    use near_sdk::json_types::U128;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::get_created_receipts;

    use super::*;
    use crate::test_utils::*;
    use crate::types::{DaySummary, Member, Outcome};

    /// An arbitrary jackpot well below the testnet pot (5 × 10^26).
    const JACKPOT: u128 = 7_000_000_000_000_000_000_000;
    /// Fixed seed of the t14 tests: 32 bytes of 0x2a.
    const SEED: [u8; 32] = [0x2a; 32];

    fn balance(c: &Contract, account_id: &near_sdk::AccountId) -> u128 {
        ft::ft_balance_of(c, account_id.clone()).0
    }

    /// I1 and I13 (S17).
    fn assert_i1_i13(c: &Contract) {
        assert_eq!(
            balance(c, &contract_id()),
            c.pot + c.reserved + c.stake_pool + c.faucet_left + c.jackpot_pending,
            "I1"
        );
        let pending: u128 = c.pending_heroes.iter().map(|p| p.jackpot).sum();
        assert_eq!(c.jackpot_pending, pending, "I13");
    }

    /// What `settle_open_day` does for a successful day (S8): the jackpot moves from `pot` to
    /// `jackpot_pending` (it stays on the contract's balance) and a `PendingHero` is pushed.
    fn add_pending(c: &mut Contract, day: u32, closers: &[near_sdk::AccountId], jackpot: u128) {
        c.pot -= jackpot;
        c.jackpot_pending += jackpot;
        c.pending_heroes.push(PendingHero {
            day,
            closers: closers.to_vec(),
            jackpot,
        });
    }

    /// testnet contract; alice…eve registered in the token with a zero balance.
    fn fixture() -> Contract {
        let mut c = setup("testnet");
        for a in [alice(), bob(), carol(), dave(), eve()] {
            register_and_fund(&mut c, &a, 0);
        }
        c
    }

    fn five() -> Vec<near_sdk::AccountId> {
        vec![alice(), bob(), carol(), dave(), eve()]
    }

    fn member() -> Member {
        Member {
            stake: 0,
            join_day: 0,
            activation_day: 2,
            last_checkin: Some(4),
            resolved_through: 2,
            claimable: 0,
            checkins: 1,
            personal_streak: 1,
            best_personal_streak: 1,
            hero_count: 0,
            storage_deposit: 0,
            checkin_key: None,
        }
    }

    fn summary(day: u32) -> DaySummary {
        DaySummary {
            day,
            outcome: Outcome::Success,
            goal: 5,
            count: 5,
            streak_after: 1,
            per_share: U128(JACKPOT / 10),
            hero: None,
            jackpot: U128(JACKPOT),
            pot_burned: U128(0),
            stake_slashed: U128(0),
            pot_after: U128(0),
        }
    }

    /// `pick_hero` as the runtime runs it: through the exported method, from the contract itself.
    fn run_pick_hero(c: &mut Contract, day: u32, seed: [u8; 32]) {
        context(&contract_id(), NO_DEPOSIT);
        set_seed(seed);
        c.pick_hero(day);
    }

    fn hero_events() -> Vec<near_sdk::serde_json::Value> {
        event_logs()
            .into_iter()
            .filter(|e| e["event"] == "hero")
            .collect()
    }

    /// The only receipt is `pick_hero({"day": day})` on the contract, 0 deposit, exactly
    /// `PICK_HERO_GAS` static gas with unused-gas weight 1.
    fn assert_one_pick_hero_receipt(day: u32) {
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1, "exactly one receipt");
        assert_eq!(receipts[0].receiver_id, contract_id());
        assert!(receipts[0].receipt_indices.is_empty(), "not chained");
        assert_eq!(receipts[0].actions.len(), 1);
        match &receipts[0].actions[0] {
            MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                gas_weight,
                ..
            } => {
                assert_eq!(method_name.as_slice(), b"pick_hero");
                let args: near_sdk::serde_json::Value =
                    near_sdk::serde_json::from_slice(args).expect("JSON args");
                assert_eq!(args, near_sdk::serde_json::json!({ "day": day }));
                assert_eq!(*attached_deposit, NearToken::from_yoctonear(0));
                assert_eq!(*prepaid_gas, Gas::from_tgas(10));
                assert_eq!(gas_weight.0, 1);
            }
            other => panic!("unexpected action {other:?}"),
        }
    }

    // ---- t14: deterministic draw ----

    /// Expected indices, computed independently of `math::hero_index`:
    /// `python3 -c 'import hashlib,struct; h=hashlib.sha256(bytes([0x2a])*32 +
    /// struct.pack("<I", D) + b"lastcall").digest(); print(struct.unpack("<Q", h[:8])[0] % 5)'`
    /// → day 4: 4 091 636 680 988 179 732 % 5 = 2; day 10: 11 561 294 825 692 679 299 % 5 = 4.
    #[test]
    fn t14_fixed_seed_picks_expected_hero() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        assert_i1_i13(&c);
        let pot = c.pot;

        run_pick_hero(&mut c, 4, SEED);
        let events = event_logs();
        assert!(get_created_receipts().is_empty(), "no external calls");

        // closers[2] = carol.
        assert_eq!(events.len(), 2, "ft_transfer + hero");
        assert_eq!(events[0]["event"], "ft_transfer");
        assert_eq!(events[0]["data"][0]["new_owner_id"], "carol.near");
        assert_eq!(events[0]["data"][0]["amount"], JACKPOT.to_string());
        assert_eq!(events[1]["event"], "hero");
        assert_eq!(
            events[1]["data"],
            near_sdk::serde_json::json!({
                "day": 4, "account_id": "carol.near", "jackpot": JACKPOT.to_string(), "paid": true
            })
        );
        assert_eq!(balance(&c, &carol()), JACKPOT);
        for a in [alice(), bob(), dave(), eve()] {
            assert_eq!(balance(&c, &a), 0);
        }
        assert_eq!(c.jackpot_pending, 0);
        assert_eq!(c.total_jackpots, JACKPOT);
        assert_eq!(c.pot, pot, "a paid jackpot does not return to the pot");
        assert!(c.pending_heroes.is_empty());
        assert_i1_i13(&c);
    }

    #[test]
    fn t14_different_days_pick_different_heroes() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        add_pending(&mut c, 10, &five(), 2 * JACKPOT);
        assert_i1_i13(&c);

        // Same seed, same closers: day 10 → index 4 (eve), day 4 → index 2 (carol).
        run_pick_hero(&mut c, 10, SEED);
        assert_eq!(hero_events()[0]["data"]["account_id"], "eve.near");
        assert_eq!(c.pending_heroes.len(), 1);
        assert_eq!(c.pending_heroes[0].day, 4);
        assert_i1_i13(&c);

        run_pick_hero(&mut c, 4, SEED);
        assert_eq!(hero_events()[0]["data"]["account_id"], "carol.near");
        assert_eq!(balance(&c, &eve()), 2 * JACKPOT);
        assert_eq!(balance(&c, &carol()), JACKPOT);
        assert_eq!(c.total_jackpots, 3 * JACKPOT);
        assert_i1_i13(&c);
    }

    // ---- t15: unregistered hero ----

    #[test]
    fn t15_unregistered_hero_jackpot_to_pot() {
        let mut c = setup("testnet");
        // frank checked in but is not (or no longer) registered in the token.
        let frank = frank();
        assert!(!ft::is_registered(&c.token, &frank));
        add_pending(&mut c, 4, std::slice::from_ref(&frank), JACKPOT);
        assert_i1_i13(&c);
        let pot = c.pot;

        run_pick_hero(&mut c, 4, SEED);
        let events = event_logs();
        assert_eq!(events.len(), 1, "no ft_transfer");
        assert_eq!(
            events[0]["data"],
            near_sdk::serde_json::json!({
                "day": 4, "account_id": "frank.near", "jackpot": JACKPOT.to_string(), "paid": false
            })
        );
        assert_eq!(c.pot, pot + JACKPOT);
        assert_eq!(c.jackpot_pending, 0);
        assert_eq!(c.total_jackpots, 0);
        assert!(c.pending_heroes.is_empty());
        assert!(!ft::is_registered(&c.token, &frank));
        assert_i1_i13(&c);
    }

    // ---- pick_hero branches ----

    /// Through the exported `Contract::pick_hero` with `predecessor = current_account_id`.
    /// The `#[private]` rejection of other callers lives only in the wasm export wrapper generated
    /// by near-sdk (`#[cfg(target_arch = "wasm32")]`), so a native call cannot exercise it: that
    /// part is for the sandbox (C11).
    #[test]
    fn pick_hero_from_contract_itself_passes() {
        let mut c = fixture();
        add_pending(&mut c, 4, &[bob()], JACKPOT);
        context(&contract_id(), NO_DEPOSIT);
        assert_eq!(env::predecessor_account_id(), env::current_account_id());
        c.pick_hero(4);
        assert_eq!(hero_events().len(), 1);
        assert_eq!(balance(&c, &bob()), JACKPOT);
        assert_i1_i13(&c);
    }

    #[test]
    fn pick_hero_repeat_is_noop() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        run_pick_hero(&mut c, 4, SEED);
        let (pot, pending, jackpots) = (c.pot, c.jackpot_pending, c.total_jackpots);
        let carol_balance = balance(&c, &carol());

        // Second call for the same day (e.g. a retry raced the original promise).
        run_pick_hero(&mut c, 4, [0x55; 32]);
        assert!(get_logs_empty());
        assert!(get_created_receipts().is_empty());
        assert_eq!(
            (c.pot, c.jackpot_pending, c.total_jackpots),
            (pot, pending, jackpots)
        );
        assert_eq!(balance(&c, &carol()), carol_balance);
        assert_i1_i13(&c);
    }

    #[test]
    fn pick_hero_unknown_day_is_noop() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        let (pot, pending) = (c.pot, c.jackpot_pending);
        run_pick_hero(&mut c, 5, SEED);
        assert!(get_logs_empty());
        assert_eq!((c.pot, c.jackpot_pending), (pot, pending));
        assert_eq!(c.pending_heroes.len(), 1);
        assert_i1_i13(&c);
    }

    #[test]
    fn pick_hero_empty_closers_returns_jackpot_to_pot_without_event() {
        let mut c = fixture();
        add_pending(&mut c, 4, &[], JACKPOT);
        add_pending(&mut c, 6, &[alice()], JACKPOT);
        let pot = c.pot;
        run_pick_hero(&mut c, 4, SEED);
        assert!(get_logs_empty(), "no event");
        assert_eq!(c.pot, pot + JACKPOT);
        assert_eq!(c.jackpot_pending, JACKPOT, "the other record stays pending");
        assert_eq!(c.total_jackpots, 0);
        assert_eq!(c.pending_heroes.len(), 1);
        assert_eq!(c.pending_heroes[0].day, 6);
        assert_i1_i13(&c);
    }

    #[test]
    fn hero_count_grows_only_for_member() {
        let mut c = fixture();
        c.members.insert(alice(), member());
        // One closer: the index is 0 whatever the seed.
        add_pending(&mut c, 4, &[alice()], JACKPOT);
        add_pending(&mut c, 5, &[bob()], JACKPOT);

        run_pick_hero(&mut c, 4, SEED);
        assert_eq!(c.members.get(&alice()).map(|m| m.hero_count), Some(1));

        // bob is registered in the token but not a member: paid, no member record appears.
        run_pick_hero(&mut c, 5, SEED);
        assert_eq!(hero_events()[0]["data"]["paid"], true);
        assert_eq!(balance(&c, &bob()), JACKPOT);
        assert!(c.members.get(&bob()).is_none());
        assert_eq!(c.members.get(&alice()).map(|m| m.hero_count), Some(1));
        assert_eq!(c.total_jackpots, 2 * JACKPOT);
        assert_i1_i13(&c);
    }

    #[test]
    fn unregistered_member_hero_count_unchanged() {
        // A member is always registered (it cannot unregister), but the branch must not count a
        // hero that was not paid.
        let mut c = setup("testnet");
        c.members.insert(frank(), member());
        add_pending(&mut c, 4, &[frank()], JACKPOT);
        run_pick_hero(&mut c, 4, SEED);
        assert_eq!(c.members.get(&frank()).map(|m| m.hero_count), Some(0));
        assert_i1_i13(&c);
    }

    #[test]
    fn history_slot_updated_only_when_day_matches() {
        let mut c = fixture();
        // Slot 4 holds day 4; slot 5 already holds day 69 (5 + 64); slot 6 is empty.
        c.history.insert(4, summary(4));
        c.history.insert(5, summary(69));
        add_pending(&mut c, 4, &[alice()], JACKPOT);
        add_pending(&mut c, 5, &[bob()], JACKPOT);
        add_pending(&mut c, 6, &[carol()], JACKPOT);

        run_pick_hero(&mut c, 4, SEED);
        run_pick_hero(&mut c, 5, SEED);
        run_pick_hero(&mut c, 6, SEED);

        let mut expected = summary(4);
        expected.hero = Some(alice());
        assert_eq!(c.history.get(&4), Some(&expected));
        assert_eq!(
            c.history.get(&5),
            Some(&summary(69)),
            "a later day's slot is untouched"
        );
        assert!(c.history.get(&6).is_none(), "no slot is created");
        assert_i1_i13(&c);
    }

    // ---- retry_pick_hero ----

    #[test]
    #[should_panic(expected = "ERR_NO_PENDING_HERO")]
    fn retry_without_pending_record_fails() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        context(&alice(), NO_DEPOSIT);
        c.retry_pick_hero(5);
    }

    #[test]
    #[should_panic(expected = "ERR_LOW_GAS")]
    fn retry_with_low_gas_fails() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        context(&alice(), NO_DEPOSIT);
        set_prepaid_gas(Gas::from_tgas(15));
        c.retry_pick_hero(4);
    }

    #[test]
    fn retry_schedules_one_pick_hero_and_draws_nothing() {
        let mut c = fixture();
        add_pending(&mut c, 4, &five(), JACKPOT);
        let (pot, pending) = (c.pot, c.jackpot_pending);
        context(&alice(), NO_DEPOSIT);
        c.retry_pick_hero(4);
        assert_one_pick_hero_receipt(4);
        assert!(get_logs_empty());
        assert_eq!((c.pot, c.jackpot_pending), (pot, pending));
        assert_eq!(c.pending_heroes.len(), 1);
        assert_i1_i13(&c);
    }

    // ---- shared helpers for C5 ----

    #[test]
    fn schedule_pick_hero_creates_receipt_without_returning_it() {
        context(&alice(), NO_DEPOSIT);
        schedule_pick_hero(4_000_000_000);
        assert_one_pick_hero_receipt(4_000_000_000);
    }

    /// Gas burnt by the host calls of `require_pick_hero_gas` up to the `used_gas` read
    /// (`prepaid_gas`, then `used_gas`) in a fresh context: the mocked VM charges host-call costs.
    fn gas_used_at_check() -> u64 {
        set_prepaid_gas(DEFAULT_PREPAID_GAS);
        let _ = env::prepaid_gas();
        env::used_gas().as_gas()
    }

    #[test]
    fn require_pick_hero_gas_exact_boundary_passes() {
        let used = gas_used_at_check();
        assert!(used > 0);
        // 10 Tgas + 5 Tgas left after the reads.
        set_prepaid_gas(Gas::from_gas(15_000_000_000_000 + used));
        require_pick_hero_gas();
    }

    #[test]
    #[should_panic(expected = "ERR_LOW_GAS")]
    fn require_pick_hero_gas_one_below_fails() {
        let used = gas_used_at_check();
        set_prepaid_gas(Gas::from_gas(15_000_000_000_000 + used - 1));
        require_pick_hero_gas();
    }

    fn get_logs_empty() -> bool {
        near_sdk::test_utils::get_logs().is_empty()
    }
}
