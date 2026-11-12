//! Unit-test harness (C1). `assert_invariants` is filled in by C9.
//!
//! The harness keeps the current call context (time, height, seed, predecessor, deposit, prepaid
//! gas) in a thread-local and re-applies it with `testing_env!` on every setter, so setters
//! compose: `context(&alice(), ONE_YOCTO)` then `set_height(7)` keeps alice and the deposit.
//! Storage and `storage_usage` carry over between contexts; logs and created receipts do not (each
//! `testing_env!` starts a fresh `MockedBlockchain`). One contract per test (per test thread).

use std::cell::RefCell;
use std::collections::BTreeMap;

use near_contract_standards::fungible_token::metadata::{FT_METADATA_SPEC, FungibleTokenMetadata};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, Gas, NearToken, env, near, serde_json, testing_env};

use crate::Contract;
use crate::config::Config;

/// The parameter sets of spec S2 (shared with the TS side).
pub const PARAMS_JSON: &str = include_str!("../../config/params.json");
/// Block timestamp of `new` in `setup` (arbitrary, fixed).
pub const LAUNCH_NS: u64 = 1_800_000_000_000_000_000;
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
/// Prepaid gas of every call unless `set_prepaid_gas` changes it (the per-transaction maximum).
pub const DEFAULT_PREPAID_GAS: Gas = Gas::from_tgas(300);

/// One set of `config/params.json`: the arguments of `new` without `initial_holder` and `metadata`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ParamSet {
    pub config: Config,
    pub total_supply: U128,
    pub pot_bps: u16,
    pub faucet_bps: u16,
}

/// `params("mainnet" | "testnet" | "demo")`.
pub fn params(set: &str) -> ParamSet {
    let mut all: BTreeMap<String, ParamSet> =
        serde_json::from_str(PARAMS_JSON).expect("config/params.json must match the S2 format");
    all.remove(set)
        .unwrap_or_else(|| panic!("no parameter set {set:?} in config/params.json"))
}

fn account(name: &str) -> AccountId {
    name.parse().expect("valid test account id")
}

pub fn contract_id() -> AccountId {
    account("lastcall.near")
}
/// `initial_holder` in `setup` (holds the non-pot, non-faucet supply).
pub fn owner() -> AccountId {
    account("owner.near")
}
pub fn alice() -> AccountId {
    account("alice.near")
}
pub fn bob() -> AccountId {
    account("bob.near")
}
pub fn carol() -> AccountId {
    account("carol.near")
}
pub fn dave() -> AccountId {
    account("dave.near")
}
pub fn eve() -> AccountId {
    account("eve.near")
}
pub fn frank() -> AccountId {
    account("frank.near")
}
/// `user0.near`, `user1.near`, … for fuzz and many-member tests.
pub fn user(i: u32) -> AccountId {
    account(&format!("user{i}.near"))
}

/// Token metadata used by `setup`.
pub fn metadata() -> FungibleTokenMetadata {
    FungibleTokenMetadata {
        spec: FT_METADATA_SPEC.to_string(),
        name: "Last Call".to_string(),
        symbol: "LAST".to_string(),
        icon: None,
        reference: None,
        reference_hash: None,
        decimals: 18,
    }
}

struct Harness {
    launch_ns: u64,
    day_length_s: u64,
    timestamp_ns: u64,
    height: u64,
    seed: [u8; 32],
    predecessor: AccountId,
    deposit: NearToken,
    prepaid_gas: Gas,
}

impl Harness {
    fn new(day_length_s: u64) -> Self {
        Self {
            launch_ns: LAUNCH_NS,
            day_length_s,
            timestamp_ns: LAUNCH_NS,
            height: 1,
            seed: [0; 32],
            predecessor: owner(),
            deposit: NO_DEPOSIT,
            prepaid_gas: DEFAULT_PREPAID_GAS,
        }
    }

    fn apply(&self) {
        // Carry the storage usage over so that storage deltas stay consistent across contexts.
        let storage_usage = env::storage_usage();
        let context = VMContextBuilder::new()
            .current_account_id(contract_id())
            .signer_account_id(self.predecessor.clone())
            .predecessor_account_id(self.predecessor.clone())
            .attached_deposit(self.deposit)
            .block_timestamp(self.timestamp_ns)
            .block_height(self.height)
            .random_seed(self.seed)
            .prepaid_gas(self.prepaid_gas)
            .storage_usage(storage_usage)
            .build();
        testing_env!(context);
    }
}

thread_local! {
    static HARNESS: RefCell<Harness> = RefCell::new(Harness::new(86_400));
}

fn update(f: impl FnOnce(&mut Harness)) {
    HARNESS.with(|h| {
        let mut h = h.borrow_mut();
        f(&mut h);
        h.apply();
    });
}

/// The next call comes from `predecessor` (also the signer) with `deposit` attached.
pub fn context(predecessor: &AccountId, deposit: NearToken) {
    update(|h| {
        h.predecessor = predecessor.clone();
        h.deposit = deposit;
    });
}

/// Block time = `launch_ns + day × day_length_s + offset_s` (seconds), with `day_length_s` of the
/// set passed to `setup` (86 400 before any `setup`).
pub fn set_time(day: u32, offset_s: u64) {
    update(|h| {
        let seconds = u64::from(day) * h.day_length_s + offset_s;
        h.timestamp_ns = h.launch_ns + seconds * 1_000_000_000;
    });
}

pub fn set_height(height: u64) {
    update(|h| h.height = height);
}

pub fn set_seed(seed: [u8; 32]) {
    update(|h| h.seed = seed);
}

pub fn set_prepaid_gas(gas: Gas) {
    update(|h| h.prepaid_gas = gas);
}

/// All `EVENT_JSON:` logs of the current context, parsed (FT and lastcall events).
pub fn event_logs() -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).expect("EVENT_JSON log is valid JSON"))
        .collect()
}

/// Deploys a contract with parameter set `set` at `LAUNCH_NS` (day 0, height 1), `initial_holder =
/// owner()`. Panics with `todo!("C3")` until `init::new` is implemented.
pub fn setup(set: &str) -> Contract {
    let p = params(set);
    HARNESS.with(|h| {
        let mut h = h.borrow_mut();
        *h = Harness::new(p.config.day_length_s);
        h.apply();
    });
    Contract::new(
        p.config,
        p.total_supply,
        p.pot_bps,
        p.faucet_bps,
        owner(),
        metadata(),
    )
}

/// Registers `account_id` in the token (if needed) and moves `amount` from `owner()` to it,
/// directly through `FungibleToken` (no `storage_deposit` / `ft_transfer` call). Needs a contract
/// from `setup`.
pub fn register_and_fund(c: &mut Contract, account_id: &AccountId, amount: u128) {
    if !c.token.accounts.contains_key(account_id) {
        c.token.internal_register_account(account_id);
    }
    if amount > 0 {
        c.token
            .internal_transfer(&owner(), account_id, amount, None);
    }
}

/// Invariants I1–I13 (spec S17). TODO(C9).
pub fn assert_invariants(_c: &Contract) {
    todo!("C9")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_sets_parse() {
        for set in ["mainnet", "testnet", "demo"] {
            params(set);
        }
    }

    #[test]
    #[should_panic(expected = "no parameter set")]
    fn unknown_param_set_panics() {
        params("devnet");
    }

    #[test]
    fn context_and_setters_compose() {
        context(&alice(), ONE_YOCTO);
        set_height(42);
        set_seed([7; 32]);
        set_prepaid_gas(Gas::from_tgas(20));
        assert_eq!(env::predecessor_account_id(), alice());
        assert_eq!(env::signer_account_id(), alice());
        assert_eq!(env::current_account_id(), contract_id());
        assert_eq!(env::attached_deposit(), ONE_YOCTO);
        assert_eq!(env::block_height(), 42);
        assert_eq!(env::random_seed_array(), [7; 32]);
        assert_eq!(env::prepaid_gas(), Gas::from_tgas(20));
    }

    #[test]
    fn set_time_is_relative_to_launch() {
        // Before any `setup` the day is 86 400 s.
        set_time(0, 0);
        assert_eq!(env::block_timestamp(), 1_800_000_000_000_000_000);
        // Day 3, 59 s in: 1.8e18 + (3 × 86 400 + 59) × 10^9 = 1.8e18 + 259 259 × 10^9.
        set_time(3, 59);
        assert_eq!(env::block_timestamp(), 1_800_259_259_000_000_000);
    }

    #[test]
    fn storage_carries_over_between_contexts() {
        context(&alice(), NO_DEPOSIT);
        env::storage_write(b"k", b"v");
        let usage = env::storage_usage();
        set_height(2);
        assert_eq!(env::storage_read(b"k"), Some(b"v".to_vec()));
        assert_eq!(env::storage_usage(), usage);
        // Removing what was written in the previous context must not underflow.
        assert!(env::storage_remove(b"k"));
    }

    #[test]
    fn event_logs_parses_only_event_json() {
        context(&alice(), NO_DEPOSIT);
        env::log_str("plain log");
        crate::events::emit_claim(&alice(), 5);
        let events = event_logs();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"], "claim");
        assert_eq!(events[0]["data"]["amount"], "5");
    }
}
