//! NEP-141/145/148 bodies, transfer/burn helpers for the game, the faucet (spec S13, S15).
//! Owner: C3.
//!
//! NEP methods never touch days (no auto-settle, no `ERR_BACKLOG`, S5) and keep the standard
//! `assert_one_yocto` (S13).

use near_contract_standards::fungible_token::events::FtBurn;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PromiseOrValue, env, require};

use crate::Contract;
use crate::errors::{
    ERR_FAUCET_DISABLED, ERR_FAUCET_EMPTY, ERR_FAUCET_USED, ERR_INSUFFICIENT_BALANCE,
    ERR_MEMBER_CANNOT_UNREGISTER, ERR_NOT_REGISTERED, ERR_USE_JOIN,
};
use crate::events;

/// Memo of the `ft_burn` event of a forced `storage_unregister`.
const UNREGISTER_MEMO: &str = "unregister";

/// Tokens reach the contract only through `join` (S13).
fn require_not_contract(receiver_id: &AccountId) {
    require!(*receiver_id != env::current_account_id(), ERR_USE_JOIN);
}

// ---- NEP-141 ----

/// `receiver_id == current_account_id` → `ERR_USE_JOIN`; otherwise the standard implementation.
pub fn ft_transfer(c: &mut Contract, receiver_id: AccountId, amount: U128, memo: Option<String>) {
    require_not_contract(&receiver_id);
    c.token.ft_transfer(receiver_id, amount, memo)
}

/// `receiver_id == current_account_id` → `ERR_USE_JOIN`; otherwise the standard implementation.
pub fn ft_transfer_call(
    c: &mut Contract,
    receiver_id: AccountId,
    amount: U128,
    memo: Option<String>,
    msg: String,
) -> PromiseOrValue<U128> {
    require_not_contract(&receiver_id);
    c.token.ft_transfer_call(receiver_id, amount, memo, msg)
}

pub fn ft_total_supply(c: &Contract) -> U128 {
    c.token.ft_total_supply()
}

pub fn ft_balance_of(c: &Contract, account_id: AccountId) -> U128 {
    c.token.ft_balance_of(account_id)
}

/// Standard resolver, no settle. If the sender unregistered while the transfer was in flight, the
/// standard burns the refund (and writes `ft_burn` itself); the burn is added to `total_burned`
/// so that I2 stays exact.
pub fn ft_resolve_transfer(
    c: &mut Contract,
    sender_id: AccountId,
    receiver_id: AccountId,
    amount: U128,
) -> U128 {
    let before = c.token.total_supply;
    let used = c.token.ft_resolve_transfer(sender_id, receiver_id, amount);
    c.total_burned += before - c.token.total_supply;
    used
}

// ---- NEP-145 ----

pub fn storage_deposit(
    c: &mut Contract,
    account_id: Option<AccountId>,
    registration_only: Option<bool>,
) -> StorageBalance {
    c.token.storage_deposit(account_id, registration_only)
}

pub fn storage_withdraw(c: &mut Contract, amount: Option<NearToken>) -> StorageBalance {
    c.token.storage_withdraw(amount)
}

/// A member → `ERR_MEMBER_CANNOT_UNREGISTER`; otherwise the standard implementation. With `force`
/// the standard burns the remaining balance without an event: count it in `total_burned` (I2) and
/// emit `ft_burn` with memo "unregister".
pub fn storage_unregister(c: &mut Contract, force: Option<bool>) -> bool {
    let account_id = env::predecessor_account_id();
    require!(
        !c.members.contains_key(&account_id),
        ERR_MEMBER_CANNOT_UNREGISTER
    );
    let before = c.token.total_supply;
    let unregistered = c.token.storage_unregister(force);
    let burned = before - c.token.total_supply;
    if burned > 0 {
        c.total_burned += burned;
        FtBurn {
            owner_id: &account_id,
            amount: U128(burned),
            memo: Some(UNREGISTER_MEMO),
        }
        .emit();
    }
    unregistered
}

pub fn storage_balance_bounds(c: &Contract) -> StorageBalanceBounds {
    c.token.storage_balance_bounds()
}

pub fn storage_balance_of(c: &Contract, account_id: AccountId) -> Option<StorageBalance> {
    c.token.storage_balance_of(account_id)
}

// ---- NEP-148 ----

pub fn ft_metadata(c: &Contract) -> FungibleTokenMetadata {
    // Always set by `new`.
    c.metadata
        .get()
        .clone()
        .unwrap_or_else(|| env::panic_str("ft metadata is not set"))
}

// ---- Faucet (S13) ----

/// Checks in the order of S13, then contract → caller, `faucet_left −= faucet_amount`, event
/// `faucet`. Returns `faucet_amount`. No auto-settle.
pub fn faucet(c: &mut Contract) -> U128 {
    let amount = c.config.faucet_amount.0;
    require!(amount > 0, ERR_FAUCET_DISABLED);
    let caller = env::predecessor_account_id();
    require!(!c.faucet_used.contains(&caller), ERR_FAUCET_USED);
    require!(is_registered(&c.token, &caller), ERR_NOT_REGISTERED);
    require!(c.faucet_left >= amount, ERR_FAUCET_EMPTY);

    transfer_from_contract(&mut c.token, &caller, amount, None);
    c.faucet_left -= amount;
    c.faucet_used.insert(caller.clone());
    events::emit_faucet(&caller, amount);
    U128(amount)
}

// ---- Helpers for the game (C5, C6, C8) ----
//
// They take the token, not the whole contract, so that callers can hold other borrows of the
// contract's fields (e.g. a member record) at the same time. Buckets are the caller's business.

/// contract → `to` via `internal_transfer` (writes `ft_transfer` itself). `amount == 0` → nothing.
/// `to` must be registered (callers check `is_registered` where the spec allows an unregistered
/// receiver).
pub fn transfer_from_contract(
    token: &mut FungibleToken,
    to: &AccountId,
    amount: u128,
    memo: Option<&str>,
) {
    if amount == 0 {
        return;
    }
    token.internal_transfer(
        &env::current_account_id(),
        to,
        amount,
        memo.map(str::to_owned),
    );
}

/// `from` → contract via `internal_transfer` (writes `ft_transfer` itself). `from` not registered →
/// `ERR_NOT_REGISTERED`; balance < `amount` → `ERR_INSUFFICIENT_BALANCE` (S13 `join`).
pub fn transfer_to_contract(token: &mut FungibleToken, from: &AccountId, amount: u128) {
    let balance = token
        .accounts
        .get(from)
        .unwrap_or_else(|| env::panic_str(ERR_NOT_REGISTERED));
    require!(balance >= amount, ERR_INSUFFICIENT_BALANCE);
    token.internal_transfer(from, &env::current_account_id(), amount, None);
}

/// `internal_withdraw` from the contract's balance (lowers `total_supply`). Writes no event: the
/// caller emits `FtBurn` (S15).
pub fn burn_from_contract(token: &mut FungibleToken, amount: u128) {
    if amount == 0 {
        return;
    }
    token.internal_withdraw(&env::current_account_id(), amount);
}

/// Whether `account_id` is registered in the token (NEP-145).
pub fn is_registered(token: &FungibleToken, account_id: &AccountId) -> bool {
    token.accounts.contains_key(account_id)
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::FungibleTokenCore;
    use near_contract_standards::fungible_token::FungibleTokenResolver;
    use near_contract_standards::storage_management::StorageManagement;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::{Value, json};
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

    use super::*;
    use crate::test_utils::{
        NO_DEPOSIT, ONE_YOCTO, alice, bob, carol, context, contract_id, event_logs, owner,
        register_and_fund, set_time, setup,
    };
    use crate::types::Member;

    /// 10^27: `total_supply` of every set in params.json.
    const TOTAL: u128 = 1_000_000_000_000_000_000_000_000_000;
    /// `faucet_amount` of the demo set: 5 000 LAST = 5·10^21.
    const FAUCET: u128 = 5_000_000_000_000_000_000_000;
    /// demo: `faucet_left` after `new` = 10^27 × 100 / 10^4 = 10^25.
    const DEMO_FAUCET_LEFT: u128 = 10_000_000_000_000_000_000_000_000;
    /// demo: the contract's balance after `new` = pot 5·10^26 + faucet_left 10^25.
    const DEMO_CONTRACT_BALANCE: u128 = 510_000_000_000_000_000_000_000_000;

    fn balance(c: &Contract, account_id: AccountId) -> u128 {
        c.ft_balance_of(account_id).0
    }

    /// I1 (S17).
    fn assert_i1(c: &Contract) {
        assert_eq!(
            balance(c, contract_id()),
            c.pot + c.reserved + c.stake_pool + c.faucet_left + c.jackpot_pending
        );
    }

    /// I2 (S17).
    fn assert_i2(c: &Contract) {
        assert_eq!(c.token.total_supply, c.initial_supply - c.total_burned);
    }

    fn burn_event(owner_id: &str, amount: &str, memo: &str) -> Value {
        json!({
            "standard": "nep141", "version": "1.0.0", "event": "ft_burn",
            "data": [{ "owner_id": owner_id, "amount": amount, "memo": memo }],
        })
    }

    fn transfer_event(from: &str, to: &str, amount: &str, memo: Option<&str>) -> Value {
        let mut item = json!({ "old_owner_id": from, "new_owner_id": to, "amount": amount });
        if let Some(memo) = memo {
            item["memo"] = json!(memo);
        }
        json!({ "standard": "nep141", "version": "1.0.0", "event": "ft_transfer", "data": [item] })
    }

    /// A member record as `join` on day 0 of the demo set would write it.
    fn insert_member(c: &mut Contract, account_id: &AccountId) {
        let stake = c.config.join_stake.0;
        let member = Member {
            stake,
            join_day: 0,
            activation_day: 1,
            last_checkin: None,
            resolved_through: 1,
            claimable: 0,
            checkins: 0,
            personal_streak: 0,
            best_personal_streak: 0,
            hero_count: 0,
            storage_deposit: c.config.member_storage_deposit.0,
            checkin_key: None,
        };
        c.members.insert(account_id.clone(), member);
    }

    // ---- S18 #21 ----

    #[test]
    #[should_panic(expected = "ERR_USE_JOIN")]
    fn t21_ft_transfer_to_contract_rejected() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        context(&alice(), ONE_YOCTO);
        c.ft_transfer(contract_id(), U128(10), None);
    }

    #[test]
    #[should_panic(expected = "ERR_USE_JOIN")]
    fn t21_ft_transfer_call_to_contract_rejected() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        context(&alice(), ONE_YOCTO);
        let _ = c.ft_transfer_call(contract_id(), U128(10), None, String::new());
    }

    #[test]
    #[should_panic(expected = "ERR_MEMBER_CANNOT_UNREGISTER")]
    fn t21_member_cannot_unregister_even_with_force() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        insert_member(&mut c, &alice());
        context(&alice(), ONE_YOCTO);
        c.storage_unregister(Some(true));
    }

    #[test]
    fn t21_non_member_can_unregister() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 0);
        register_and_fund(&mut c, &bob(), 0);
        // alice is a member; bob, who is not, unregisters.
        insert_member(&mut c, &alice());
        context(&bob(), ONE_YOCTO);
        assert!(c.storage_unregister(None));
        assert!(!is_registered(&c.token, &bob()));
        assert!(c.storage_balance_of(bob()).is_none());
        assert!(is_registered(&c.token, &alice()));
        // The standard refund of the storage deposit (+1 yocto) goes to bob.
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, bob());
        // Zero balance: nothing burned, no ft_burn.
        assert!(get_logs().is_empty());
        assert_eq!(c.total_burned, 0);
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
    }

    /// Forced unregister with a positive balance: the standard burns it silently; the wrapper
    /// counts it in `total_burned` and writes one `ft_burn` (I2 stays exact).
    #[test]
    fn t21_forced_unregister_burn_is_counted() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        context(&alice(), ONE_YOCTO);
        assert!(c.storage_unregister(Some(true)));
        assert_eq!(get_logs().len(), 1);
        assert_eq!(
            event_logs(),
            vec![burn_event("alice.near", "100", "unregister")]
        );
        assert!(!is_registered(&c.token, &alice()));
        assert_eq!(c.ft_total_supply(), U128(TOTAL - 100));
        assert_eq!(c.total_burned, 100);
        assert_i2(&c);
        // The burn leaves the contract's buckets alone.
        assert_i1(&c);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn t21_ft_transfer_keeps_standard_one_yocto() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        register_and_fund(&mut c, &bob(), 0);
        context(&alice(), NO_DEPOSIT);
        c.ft_transfer(bob(), U128(10), None);
    }

    #[test]
    fn t21_ft_transfer_to_another_account_is_standard() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        register_and_fund(&mut c, &bob(), 0);
        context(&alice(), ONE_YOCTO);
        c.ft_transfer(bob(), U128(30), Some("hi".to_string()));
        assert_eq!(
            event_logs(),
            vec![transfer_event("alice.near", "bob.near", "30", Some("hi"))]
        );
        assert_eq!(balance(&c, alice()), 70);
        assert_eq!(balance(&c, bob()), 30);
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
    }

    // ---- S18 #22 ----

    #[test]
    #[should_panic(expected = "ERR_FAUCET_DISABLED")]
    fn t22_faucet_disabled_in_mainnet_set() {
        let mut c = setup("mainnet");
        register_and_fund(&mut c, &alice(), 0);
        context(&alice(), NO_DEPOSIT);
        c.faucet();
    }

    #[test]
    fn t22_faucet_pays_and_keeps_i1() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 0);
        context(&alice(), NO_DEPOSIT);
        assert_eq!(c.faucet(), U128(FAUCET));
        assert_eq!(
            event_logs(),
            vec![
                transfer_event(
                    "lastcall.near",
                    "alice.near",
                    "5000000000000000000000",
                    None
                ),
                json!({
                    "standard": "lastcall", "version": "1.0.0", "event": "faucet",
                    "data": { "account_id": "alice.near", "amount": "5000000000000000000000" },
                }),
            ]
        );
        assert_eq!(balance(&c, alice()), FAUCET);
        // 10^25 − 5·10^21 = 9.995·10^24.
        assert_eq!(c.faucet_left, 9_995_000_000_000_000_000_000_000);
        // 5.1·10^26 − 5·10^21.
        assert_eq!(
            balance(&c, contract_id()),
            509_995_000_000_000_000_000_000_000
        );
        assert_i1(&c);
        assert!(c.faucet_used.contains(&alice()));
        // A transfer, not a mint.
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
        // No days touched.
        assert_eq!(c.last_settled, None);

        // Another account gets its own portion.
        register_and_fund(&mut c, &bob(), 0);
        context(&bob(), NO_DEPOSIT);
        assert_eq!(c.faucet(), U128(FAUCET));
        assert_eq!(balance(&c, bob()), FAUCET);
        assert_eq!(c.faucet_left, 9_990_000_000_000_000_000_000_000);
        assert_i1(&c);
    }

    #[test]
    #[should_panic(expected = "ERR_FAUCET_USED")]
    fn t22_faucet_once_per_account() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 0);
        context(&alice(), NO_DEPOSIT);
        c.faucet();
        c.faucet();
    }

    /// Unregistering and registering again does not reset the faucet.
    #[test]
    #[should_panic(expected = "ERR_FAUCET_USED")]
    fn t22_faucet_used_survives_reregistration() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 0);
        register_and_fund(&mut c, &bob(), 0);
        context(&alice(), NO_DEPOSIT);
        c.faucet();
        context(&alice(), ONE_YOCTO);
        c.ft_transfer(bob(), U128(FAUCET), None);
        assert!(c.storage_unregister(None));
        register_and_fund(&mut c, &alice(), 0);
        context(&alice(), NO_DEPOSIT);
        c.faucet();
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_REGISTERED")]
    fn t22_faucet_unregistered_rejected() {
        let mut c = setup("demo");
        context(&alice(), NO_DEPOSIT);
        c.faucet();
    }

    #[test]
    #[should_panic(expected = "ERR_FAUCET_EMPTY")]
    fn t22_faucet_empty_rejected() {
        let mut c = setup("demo");
        c.faucet_left = FAUCET - 1;
        register_and_fund(&mut c, &alice(), 0);
        context(&alice(), NO_DEPOSIT);
        c.faucet();
    }

    /// `faucet_left == faucet_amount` still pays; then the faucet is empty.
    #[test]
    #[should_panic(expected = "ERR_FAUCET_EMPTY")]
    fn t22_faucet_pays_the_exact_remainder_then_empty() {
        let mut c = setup("demo");
        // Keep I1: move all but one portion from faucet_left to the pot.
        c.pot += DEMO_FAUCET_LEFT - FAUCET;
        c.faucet_left = FAUCET;
        assert_i1(&c);
        register_and_fund(&mut c, &alice(), 0);
        register_and_fund(&mut c, &bob(), 0);
        context(&alice(), NO_DEPOSIT);
        c.faucet();
        assert_eq!(c.faucet_left, 0);
        assert_eq!(balance(&c, alice()), FAUCET);
        assert_i1(&c);
        context(&bob(), NO_DEPOSIT);
        c.faucet();
    }

    // ---- S18 #25 (unit part) ----

    #[test]
    fn t25_ft_transfer_works_with_backlog() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 1000);
        register_and_fund(&mut c, &bob(), 0);
        // Day 600: 600 pending days > AUTO_SETTLE_CAP (50).
        set_time(600, 0);
        context(&alice(), ONE_YOCTO);
        c.ft_transfer(bob(), U128(100), None);
        // Only the transfer log: nothing settled.
        assert_eq!(
            event_logs(),
            vec![transfer_event("alice.near", "bob.near", "100", None)]
        );
        assert_eq!(balance(&c, alice()), 900);
        assert_eq!(balance(&c, bob()), 100);
        assert_eq!(c.last_settled, None);
        assert_eq!(c.open.day, 0);
    }

    /// Context of the `ft_resolve_transfer` callback: the contract calls itself, `ft_on_transfer`
    /// returned `result`. Keeps storage (testing_env! carries it over) and the block time.
    fn resolve_context(result: PromiseResult) {
        let context = VMContextBuilder::new()
            .current_account_id(contract_id())
            .signer_account_id(alice())
            .predecessor_account_id(contract_id())
            .block_timestamp(env::block_timestamp())
            .storage_usage(env::storage_usage())
            .build();
        testing_env!(
            context,
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
    }

    #[test]
    fn t25_ft_transfer_call_partial_refund_with_backlog() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 1000);
        register_and_fund(&mut c, &bob(), 0);
        set_time(600, 0);
        context(&alice(), ONE_YOCTO);
        let _ = c.ft_transfer_call(bob(), U128(100), None, "msg".to_string());
        assert_eq!(balance(&c, alice()), 900);
        assert_eq!(balance(&c, bob()), 100);
        // ft_on_transfer on bob, then ft_resolve_transfer on the contract.
        let receipts = get_created_receipts();
        let methods: Vec<(AccountId, String)> = receipts
            .iter()
            .flat_map(|r| {
                r.actions.iter().filter_map(|a| match a {
                    MockAction::FunctionCallWeight { method_name, .. } => Some((
                        r.receiver_id.clone(),
                        String::from_utf8(method_name.clone()).unwrap(),
                    )),
                    _ => None,
                })
            })
            .collect();
        assert_eq!(
            methods,
            vec![
                (bob(), "ft_on_transfer".to_string()),
                (contract_id(), "ft_resolve_transfer".to_string()),
            ]
        );

        // bob used 60 of 100 and returned 40.
        resolve_context(PromiseResult::Successful(b"\"40\"".to_vec()));
        let used = c.ft_resolve_transfer(alice(), bob(), U128(100));
        assert_eq!(used, U128(60));
        assert_eq!(
            event_logs(),
            vec![transfer_event(
                "bob.near",
                "alice.near",
                "40",
                Some("refund")
            )]
        );
        assert_eq!(balance(&c, alice()), 940);
        assert_eq!(balance(&c, bob()), 60);
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
        assert_eq!(c.total_burned, 0);
        assert_i2(&c);
        // No settle in the resolver.
        assert_eq!(c.last_settled, None);
        assert_eq!(c.open.day, 0);
    }

    /// The sender unregistered while `ft_transfer_call` was in flight: the standard burns the
    /// refund and writes `ft_burn` itself; the wrapper adds it to `total_burned` (I2 stays exact).
    #[test]
    fn t25_resolve_with_deleted_sender_burn_is_counted() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 1000);
        register_and_fund(&mut c, &bob(), 0);
        register_and_fund(&mut c, &carol(), 0);
        context(&alice(), ONE_YOCTO);
        let _ = c.ft_transfer_call(bob(), U128(100), None, "msg".to_string());
        // alice empties her balance and unregisters without force (nothing burned yet).
        c.ft_transfer(carol(), U128(900), None);
        assert!(c.storage_unregister(None));
        assert_eq!(c.total_burned, 0);

        // bob returns 40 of 100: there is nobody to refund, the 40 are burned.
        resolve_context(PromiseResult::Successful(b"\"40\"".to_vec()));
        let used = c.ft_resolve_transfer(alice(), bob(), U128(100));
        assert_eq!(used, U128(100));
        // Exactly one ft_burn, written by the standard (not duplicated).
        assert_eq!(event_logs(), vec![burn_event("bob.near", "40", "refund")]);
        assert_eq!(balance(&c, bob()), 60);
        assert_eq!(balance(&c, carol()), 900);
        assert_eq!(c.ft_total_supply(), U128(TOTAL - 40));
        assert_eq!(c.total_burned, 40);
        assert_i2(&c);
        assert_i1(&c);
    }

    // ---- Helpers ----

    #[test]
    #[should_panic(expected = "ERR_NOT_REGISTERED")]
    fn helpers_transfer_to_contract_unregistered() {
        let mut c = setup("demo");
        transfer_to_contract(&mut c.token, &alice(), 1);
    }

    #[test]
    #[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
    fn helpers_transfer_to_contract_insufficient_balance() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 99);
        transfer_to_contract(&mut c.token, &alice(), 100);
    }

    #[test]
    fn helpers_transfer_to_contract_moves_and_logs() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 100);
        context(&alice(), NO_DEPOSIT);
        transfer_to_contract(&mut c.token, &alice(), 100);
        assert_eq!(
            event_logs(),
            vec![transfer_event("alice.near", "lastcall.near", "100", None)]
        );
        assert_eq!(balance(&c, alice()), 0);
        assert_eq!(balance(&c, contract_id()), DEMO_CONTRACT_BALANCE + 100);
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
    }

    #[test]
    fn helpers_transfer_from_contract_zero_does_nothing() {
        let mut c = setup("demo");
        context(&alice(), NO_DEPOSIT);
        // Even to an unregistered account: nothing is attempted.
        transfer_from_contract(&mut c.token, &alice(), 0, Some("x"));
        assert!(get_logs().is_empty());
        assert!(!is_registered(&c.token, &alice()));
        assert_eq!(balance(&c, contract_id()), DEMO_CONTRACT_BALANCE);
    }

    #[test]
    fn helpers_transfer_from_contract_moves_and_logs() {
        let mut c = setup("demo");
        register_and_fund(&mut c, &alice(), 0);
        context(&alice(), NO_DEPOSIT);
        transfer_from_contract(&mut c.token, &alice(), 7, Some("x"));
        assert_eq!(
            event_logs(),
            vec![transfer_event(
                "lastcall.near",
                "alice.near",
                "7",
                Some("x")
            )]
        );
        assert_eq!(balance(&c, alice()), 7);
        assert_eq!(balance(&c, contract_id()), DEMO_CONTRACT_BALANCE - 7);
    }

    #[test]
    fn helpers_burn_from_contract_lowers_supply_without_log() {
        let mut c = setup("demo");
        context(&alice(), NO_DEPOSIT);
        burn_from_contract(&mut c.token, 1000);
        assert!(get_logs().is_empty());
        assert_eq!(c.ft_total_supply(), U128(TOTAL - 1000));
        assert_eq!(balance(&c, contract_id()), DEMO_CONTRACT_BALANCE - 1000);
        assert_eq!(balance(&c, owner()), 490_000_000_000_000_000_000_000_000);

        burn_from_contract(&mut c.token, 0);
        assert!(get_logs().is_empty());
        assert_eq!(c.ft_total_supply(), U128(TOTAL - 1000));
    }

    #[test]
    fn helpers_is_registered() {
        let mut c = setup("demo");
        assert!(is_registered(&c.token, &contract_id()));
        assert!(is_registered(&c.token, &owner()));
        assert!(!is_registered(&c.token, &alice()));
        register_and_fund(&mut c, &alice(), 0);
        assert!(is_registered(&c.token, &alice()));
    }
}
