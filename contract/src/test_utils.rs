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

/// Invariants I1–I13 (spec S17) that one state shows, walking all members. Day-dependent values use
/// `next` (only settled days, as `get_member`). What needs a call journal — I2 "never grows", I5,
/// I6 against the check-ins, I7 against earlier states, I9 right after a game call, I10 for days
/// no member references — is checked by `crate::tests::World` on every call.
pub fn assert_invariants(c: &Contract) {
    use std::collections::{BTreeMap, BTreeSet};

    use crate::config::HISTORY_LEN;
    use crate::types::Outcome;

    let today = crate::day::today(c);
    let next = crate::day::next(c);
    // I9 (state part): the open day is `next` and never after today.
    assert_eq!(c.open.day, next, "I9: open.day == next");
    assert!(next <= today, "I9: open day {next} after today {today}");

    // I1.
    let balance = c.token.accounts.get(&contract_id()).unwrap_or(0);
    let buckets = c.pot + c.reserved + c.stake_pool + c.faucet_left + c.jackpot_pending;
    assert_eq!(balance, buckets, "I1: contract balance vs buckets");

    // I2 (state part).
    let expected_supply = c
        .initial_supply
        .checked_sub(c.total_burned)
        .unwrap_or_else(|| panic!("I2: total_burned {} > initial_supply", c.total_burned));
    assert_eq!(c.token.total_supply, expected_supply, "I2: total_supply");

    // I3, I4, I11 and the member side of I10.
    let (mut all, mut active, mut claimable) = (0u128, 0u128, 0u128);
    let mut active_count = 0u32;
    let mut maturing: BTreeMap<u32, u32> = BTreeMap::new();
    let mut refs: BTreeMap<u32, u32> = BTreeMap::new();
    for (a, m) in c.members.iter() {
        assert_eq!(
            m.activation_day,
            m.join_day + c.config.warmup_days,
            "{a}: activation_day"
        );
        if let Some(p) = m.last_checkin {
            assert!(
                m.activation_day <= p && p <= next,
                "{a}: check-in day {p} outside [activation, open day]"
            );
            // The check-in resolves through p, later resolves go further.
            assert!(
                m.resolved_through >= p,
                "{a}: resolved_through < last_checkin"
            );
            if m.resolved_through == p {
                *refs.entry(p).or_insert(0) += 1;
            }
        }
        assert!(
            m.resolved_through <= next.max(m.activation_day),
            "{a}: resolved_through beyond the settled days"
        );
        let delta = crate::member::resolve_pure(c, m, next);
        all += delta.stake;
        claimable += m.claimable + delta.claimable_add;
        if m.activation_day <= next {
            active += delta.stake;
            active_count += 1;
        } else {
            *maturing.entry(m.activation_day).or_insert(0) += 1;
        }
    }
    assert!(
        all <= c.stake_pool,
        "I3: Σ stakes {all} > stake_pool {}",
        c.stake_pool
    );
    assert!(
        active <= c.active_stake,
        "I3: Σ active stakes {active} > active_stake {}",
        c.active_stake
    );
    assert!(
        claimable <= c.reserved,
        "I4: Σ claimable {claimable} > reserved {}",
        c.reserved
    );
    assert_eq!(active_count, c.active_count, "I11: active_count");
    assert_eq!(c.members.len(), c.members_total, "I11: members_total");
    for (day, n) in &maturing {
        assert_eq!(c.maturing.get(day), Some(n), "S6: maturing[{day}]");
    }

    // I10 for every day a member still references (the rest needs the journal).
    for (&d, &n) in &refs {
        if d >= next {
            // Today's check-in: the day is not settled yet.
            assert!(
                c.rewards.get(&d).is_none(),
                "I10: record of the open day {d}"
            );
            continue;
        }
        let slot = c.history.get(&(d % HISTORY_LEN)).filter(|s| s.day == d);
        match c.rewards.get(&d) {
            Some(r) => {
                assert_eq!(r.refs, n, "I10: rewards[{d}].refs");
                // I8: no record with a zero share.
                assert!(r.per_share > 0, "I8: rewards[{d}] with per_share 0");
                if let Some(s) = slot {
                    assert_eq!(
                        s.outcome,
                        Outcome::Success,
                        "I10: rewards[{d}] of a non-success"
                    );
                    assert_eq!(s.per_share.0, r.per_share, "rewards[{d}].per_share");
                }
            }
            None => {
                if let Some(s) = slot {
                    assert!(
                        s.outcome != Outcome::Success || s.per_share.0 == 0,
                        "I10: day {d} succeeded with a share, {n} references, no record"
                    );
                }
            }
        }
    }

    // I12.
    assert!(
        c.open.checked_stake <= c.open.active_stake,
        "I12: open.checked_stake {} > open.active_stake {}",
        c.open.checked_stake,
        c.open.active_stake
    );
    assert!(
        c.open.active_stake <= c.active_stake,
        "I12: open.active_stake {} > active_stake {}",
        c.open.active_stake,
        c.active_stake
    );
    assert!(
        c.active_stake <= c.stake_pool,
        "I12: active_stake {} > stake_pool {}",
        c.active_stake,
        c.stake_pool
    );

    // I13 and the shape of the pending heroes (S8, S11).
    let pending: u128 = c.pending_heroes.iter().map(|p| p.jackpot).sum();
    assert_eq!(c.jackpot_pending, pending, "I13: jackpot_pending");
    let k = c.config.closers_k as usize;
    let mut days = BTreeSet::new();
    for p in &c.pending_heroes {
        assert!(days.insert(p.day), "pending hero day {} twice", p.day);
        assert!(p.day < next, "pending hero of an unsettled day {}", p.day);
        assert!(
            p.jackpot > 0,
            "pending hero of day {} without a jackpot",
            p.day
        );
        assert!(
            !p.closers.is_empty() && p.closers.len() <= k,
            "pending hero of day {}: {} closers",
            p.day,
            p.closers.len()
        );
    }

    // I6 (state part): at most K closers, only within the goal, one per account.
    let closers = &c.open.closers;
    assert!(closers.len() <= k, "I6: {} closers > K", closers.len());
    assert!(
        closers.len() as u32 <= c.open.count.min(c.open.goal),
        "I6: {} closers, count {}, goal {}",
        closers.len(),
        c.open.count,
        c.open.goal
    );
    let distinct: BTreeSet<&AccountId> = closers.iter().collect();
    assert_eq!(
        distinct.len(),
        closers.len(),
        "I6: an account twice among the closers"
    );
    assert!(c.open.forfeited <= c.open.count, "R4: forfeited > count");

    // I8: the next success cannot spend more than the pot.
    let mult = crate::math::mult_bps(
        c.streak.saturating_add(1),
        c.config.streak_cap,
        c.config.streak_step_bps,
    );
    assert!(
        crate::math::budget(c.pot, c.config.emit_bps, mult) <= c.pot,
        "I8: budget > pot"
    );

    // I7 (state part): the ring holds the last HISTORY_LEN settled days.
    for d in next.saturating_sub(HISTORY_LEN)..next {
        let slot = c.history.get(&(d % HISTORY_LEN));
        assert_eq!(slot.map(|s| s.day), Some(d), "I7: history slot of day {d}");
    }
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
