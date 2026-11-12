//! C9: invariants in action, end-to-end scenarios and fuzz (spec S17, S18 8/9b/18/20/24/29).
//!
//! `World` drives the contract through its exported methods, the way the runtime would, and keeps
//! a reference model written from the spec (S5–S11, NEP-141/145) next to it:
//!
//! - every call runs in a fresh mocked context (time, block height, predecessor, deposit, gas);
//! - a call that panics is rolled back (contract root and mocked storage restored), as the runtime
//!   rolls back a failed receipt; the error must be one the model expects at that point, and the
//!   "before any work" errors (ERR_ONE_YOCTO, ERR_BACKLOG, ERR_LOW_GAS, R6) must leave the state
//!   untouched even without the rollback;
//! - after every call the model's state must equal the contract's (buckets, open day, pending
//!   heroes, members through `get_member`, FT balances, history ring, failed bits, created
//!   receipts), `assert_invariants` (I1–I4, I6, I8–I13) must hold, and the journal checks run:
//!   I2 (supply never grows), I5 (one check-in a day), I6 (closers from the check-in journal), I7
//!   (settled days and config never change), I9 (`last_settled == today − 1` after a game call),
//!   I10 (no reward record beyond the members' references).
//!
//! The model is eager where the contract is lazy: a failed day slashes every active member who did
//! not check in at once, a successful day credits the share at once. The contract's lazy values
//! (`resolve_pure` with `t = next`, seen through `get_member`) must equal the eager ones.
//!
//! Contexts are installed with a cached VM config: the `test_utils` setters call `testing_env!`,
//! which builds `test_vm_config()` anew on every call (about 20 ms in debug), too slow for the
//! 10^5 calls of the fuzz. Storage and `storage_usage` carry over exactly as in `testing_env!`.

mod fuzz;
mod scenarios;

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Once;

use ed25519_dalek::{Signer, SigningKey};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::mock::{MockAction, MockedBlockchain};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, Gas, NearToken, PublicKey, borsh, env, serde_json};

use crate::config::{AUTO_SETTLE_CAP, Config, HISTORY_LEN, MAX_SETTLE_DAYS};
use crate::errors::*;
use crate::test_utils::{LAUNCH_NS, ParamSet, assert_invariants, contract_id, metadata, owner};
use crate::types::{CheckInResult, DaySummary, OpenDay, Outcome, PendingHero};
use crate::{Contract, bits, views};

/// `B`.
pub(crate) const B: u128 = 10_000;
/// `member_storage_deposit` of every parameter set: 10^22 yocto.
pub(crate) const DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
/// Prepaid gas of a normal call.
pub(crate) const FULL_GAS: Gas = Gas::from_tgas(300);
/// Prepaid gas below `PICK_HERO_GAS + GAS_RESERVE` (15 Tgas): ERR_LOW_GAS on a successful day.
pub(crate) const LOW_GAS: Gas = Gas::from_tgas(14);

// ---- Fast mocked contexts ----

/// `make()` once per thread, then clones (`test_vm_config()` costs ~20 ms in debug).
fn cached<T: Clone + 'static>(make: fn() -> T) -> T {
    thread_local! {
        static CACHE: RefCell<Option<Box<dyn Any>>> = const { RefCell::new(None) };
    }
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let value = cache.get_or_insert_with(|| Box::new(make()));
        value
            .downcast_ref::<T>()
            .expect("one cached type per thread")
            .clone()
    })
}

/// The mocked call context of the next call.
#[derive(Clone, Debug)]
pub(crate) struct Ctx {
    pub launch_ns: u64,
    pub day_length_s: u64,
    pub timestamp_ns: u64,
    pub height: u64,
    pub seed: [u8; 32],
    pub predecessor: AccountId,
    pub deposit: u128,
    pub prepaid_gas: Gas,
}

impl Ctx {
    fn install(&self, storage: HashMap<Vec<u8>, Vec<u8>>, storage_usage: u64) {
        let context = VMContextBuilder::new()
            .current_account_id(contract_id())
            .signer_account_id(self.predecessor.clone())
            .predecessor_account_id(self.predecessor.clone())
            .attached_deposit(NearToken::from_yoctonear(self.deposit))
            .block_timestamp(self.timestamp_ns)
            .block_height(self.height)
            .random_seed(self.seed)
            .prepaid_gas(self.prepaid_gas)
            .storage_usage(storage_usage)
            .build();
        env::set_blockchain_interface(MockedBlockchain::new(
            context,
            cached(near_sdk::test_vm_config),
            near_sdk::RuntimeFeesConfig::test(),
            vec![],
            storage,
            HashMap::new(),
            None,
        ));
    }

    /// A fresh mocked blockchain with the current storage (what `testing_env!` does): resets the
    /// logs, the receipts and the gas counter.
    fn apply(&self) {
        let usage = env::storage_usage();
        let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        self.install(storage, usage);
    }
}

// ---- Expected panics ----

thread_local! {
    /// Set while a call that may panic runs: the panic hook stays quiet.
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

/// Silences the default panic message of calls expected to fail (thousands in the fuzz); any
/// other panic (a failed assertion) prints as usual.
fn install_quiet_hook() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                default(info);
            }
        }));
    });
}

fn panic_text(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_else(|| "<non-string panic>".to_owned())
}

/// The contract's error string: `env::panic_str` arrives as `HostError(GuestPanic { panic_msg:
/// "…" })`, `require!` as the plain message.
pub(crate) fn error_of(message: &str) -> String {
    const KEY: &str = "panic_msg: \"";
    match message.find(KEY) {
        Some(at) => {
            let rest = &message[at + KEY.len()..];
            rest[..rest.find('"').unwrap_or(rest.len())].to_owned()
        }
        None => message.to_owned(),
    }
}

/// Standard messages of near-contract-standards / near-sdk (not S16).
pub(crate) mod std_err {
    pub const ONE_YOCTO: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
    pub const NOT_ENOUGH: &str = "The account doesn't have enough balance";
    pub const SAME: &str = "Sender and receiver should be different";
    pub const ZERO: &str = "The amount should be a positive number";
    /// `The account <id> is not registered`.
    pub const NOT_REGISTERED: &str = "is not registered";
    pub const POSITIVE_BALANCE: &str =
        "Can't unregister the account with the positive balance without force";
    pub const GAS: &str = "GasExceeded";
}

// ---- Rollback ----

struct Snapshot {
    root: Vec<u8>,
    storage: HashMap<Vec<u8>, Vec<u8>>,
    usage: u64,
}

/// Writes the lazy caches of every `store` collection (what the end of a receipt does).
fn flush(c: &mut Contract) {
    c.metadata.flush();
    c.maturing.flush();
    c.rewards.flush();
    c.failed_bits.flush();
    c.history.flush();
    c.members.flush();
    // `faucet_used` (store::LookupSet) and the token's accounts (collections::LookupMap) write
    // through.
}

// ---- Reference model ----

/// A member in the model: `stake` and `claimable` are eager (all settled days applied).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberModel {
    pub stake: u128,
    pub claimable: u128,
    pub join_day: u32,
    pub activation_day: u32,
    pub last_checkin: Option<u32>,
    pub checkins: u32,
    pub personal_streak: u32,
    pub best_personal_streak: u32,
    pub hero_count: u32,
    pub storage_deposit: u128,
    pub checkin_key: Option<PublicKey>,
}

/// NEAR transfers, `pick_hero` promises and `lastcall` events of one call (actual or expected).
#[derive(Clone, Debug, Default)]
pub(crate) struct Receipts {
    /// `(receiver, amount)`; `None` = any amount (the NEP-145 refund of `storage_unregister`).
    pub transfers: Vec<(AccountId, Option<u128>)>,
    pub pick_hero: Vec<u32>,
    /// `lastcall` events except `days_settled` (compared on its own), as `{event, data}`.
    pub events: Vec<serde_json::Value>,
}

fn event(name: &str, data: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "event": name, "data": data })
}

/// Errors the model accepts for a call: one of them must be raised.
pub(crate) type Errs = Vec<&'static str>;

/// The spec as an eager state machine (S3, S5–S11, S13, NEP-141/145).
#[derive(Clone, Debug)]
pub(crate) struct Model {
    pub cfg: Config,
    pub initial_supply: u128,
    pub supply: u128,
    pub pot: u128,
    pub reserved: u128,
    pub stake_pool: u128,
    pub faucet_left: u128,
    pub jackpot_pending: u128,
    pub last_settled: Option<u32>,
    pub streak: u32,
    pub longest_streak: u32,
    pub active_count: u32,
    pub active_stake: u128,
    pub members_total: u32,
    pub open: OpenDay,
    pub pending_heroes: Vec<PendingHero>,
    pub members: BTreeMap<AccountId, MemberModel>,
    /// FT balances of the registered accounts.
    pub balances: BTreeMap<AccountId, u128>,
    pub faucet_used: BTreeSet<AccountId>,
    pub total_burned: u128,
    pub total_rewarded: u128,
    pub total_jackpots: u128,
    /// Every settled day, index = day.
    pub days: Vec<DaySummary>,
    /// Receipts of the call being modelled.
    pub out: Receipts,
}

impl Model {
    fn new(p: &ParamSet) -> Self {
        let supply = p.total_supply.0;
        let pot = supply * u128::from(p.pot_bps) / B;
        let faucet_left = supply * u128::from(p.faucet_bps) / B;
        let mut balances = BTreeMap::new();
        balances.insert(contract_id(), pot + faucet_left);
        balances.insert(owner(), supply - pot - faucet_left);
        Self {
            cfg: p.config.clone(),
            initial_supply: supply,
            supply,
            pot,
            reserved: 0,
            stake_pool: 0,
            faucet_left,
            jackpot_pending: 0,
            last_settled: None,
            streak: 0,
            longest_streak: 0,
            active_count: 0,
            active_stake: 0,
            members_total: 0,
            open: OpenDay::default(),
            pending_heroes: Vec::new(),
            members: BTreeMap::new(),
            balances,
            faucet_used: BTreeSet::new(),
            total_burned: 0,
            total_rewarded: 0,
            total_jackpots: 0,
            days: Vec::new(),
            out: Receipts::default(),
        }
    }

    fn b(&self) -> u128 {
        u128::from(self.cfg.slash_bps)
    }

    pub fn next(&self) -> u32 {
        self.last_settled.map_or(0, |d| d + 1)
    }

    fn registered(&self, a: &AccountId) -> bool {
        self.balances.contains_key(a)
    }

    pub fn balance(&self, a: &AccountId) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }

    /// `internal_transfer`, checks done by the caller.
    fn transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        *self.balances.get_mut(from).expect("sender registered") -= amount;
        *self.balances.get_mut(to).expect("receiver registered") += amount;
    }

    /// FT burn from the contract's balance (S8, S10).
    fn burn(&mut self, amount: u128) {
        *self.balances.get_mut(&contract_id()).expect("contract") -= amount;
        self.supply -= amount;
        self.total_burned += amount;
    }

    /// S6 goal: 0 below `min_goal`, else `max(min_goal, ⌈n × goal_bps / B⌉)`.
    fn goal_for(&self, n: u32) -> u32 {
        if n < self.cfg.min_goal {
            return 0;
        }
        let share = (u64::from(n) * u64::from(self.cfg.goal_bps)).div_ceil(10_000);
        u32::try_from(share.max(u64::from(self.cfg.min_goal))).expect("goal fits")
    }

    /// S6.
    fn open_day(&mut self, d: u32) {
        let m = self
            .members
            .values()
            .filter(|mm| mm.activation_day == d)
            .count() as u32;
        self.active_count += m;
        self.active_stake += u128::from(m) * self.cfg.join_stake.0;
        self.open = OpenDay {
            day: d,
            goal: self.goal_for(self.active_count),
            active: self.active_count,
            active_stake: self.active_stake,
            count: 0,
            checked_stake: 0,
            forfeited: 0,
            closers: Vec::new(),
            closer_height: 0,
        };
    }

    fn open_succeeds(&self) -> bool {
        self.open.goal > 0 && self.open.count >= self.open.goal
    }

    /// S8 for the open day, then `open_day(d + 1)`.
    fn settle_open_day(&mut self) {
        let d = self.open.day;
        let outcome = if self.open.goal == 0 {
            Outcome::Idle
        } else if self.open.count >= self.open.goal {
            Outcome::Success
        } else if self.active_count == 0 {
            Outcome::Idle
        } else {
            Outcome::Fail
        };
        let (mut per_share, mut jackpot_set_aside, mut pot_burn, mut slash) = (0, 0, 0, 0);
        match outcome {
            Outcome::Idle => {}
            Outcome::Success => {
                self.streak += 1;
                self.longest_streak = self.longest_streak.max(self.streak);
                let mult = B + u128::from(self.streak.min(self.cfg.streak_cap))
                    * u128::from(self.cfg.streak_step_bps);
                let budget = self.pot * u128::from(self.cfg.emit_bps) * mult / (B * B);
                assert!(budget <= self.pot, "I8: budget {budget} > pot {}", self.pot);
                per_share =
                    budget / (u128::from(self.open.count) + u128::from(self.cfg.jackpot_mult));
                let shares = self.open.count - self.open.forfeited;
                if per_share > 0 && shares > 0 {
                    let total = per_share * u128::from(shares);
                    self.pot -= total;
                    self.reserved += total;
                    self.total_rewarded += total;
                    let mut credited = 0;
                    for mm in self.members.values_mut() {
                        if mm.last_checkin == Some(d) {
                            mm.claimable += per_share;
                            credited += 1;
                        }
                    }
                    assert_eq!(credited, shares, "model: shares of day {d}");
                }
                let jackpot = per_share * u128::from(self.cfg.jackpot_mult);
                if jackpot > 0 && !self.open.closers.is_empty() {
                    self.pot -= jackpot;
                    self.jackpot_pending += jackpot;
                    self.pending_heroes.push(PendingHero {
                        day: d,
                        closers: self.open.closers.clone(),
                        jackpot,
                    });
                    self.out.pick_hero.push(d);
                    jackpot_set_aside = jackpot;
                }
            }
            Outcome::Fail => {
                self.streak = 0;
                pot_burn = self.pot * u128::from(self.cfg.burn_bps) / B;
                self.pot -= pot_burn;
                slash = ((self.open.active_stake - self.open.checked_stake) * self.b() / B)
                    .min(self.active_stake);
                self.stake_pool -= slash;
                self.active_stake -= slash;
                self.burn(pot_burn + slash);
                let keep = B - self.b();
                for mm in self.members.values_mut() {
                    if mm.activation_day <= d && mm.last_checkin != Some(d) {
                        mm.stake = mm.stake * keep / B;
                    }
                }
            }
        }
        assert_eq!(
            self.days.len(),
            d as usize,
            "model: days are settled in order"
        );
        self.days.push(DaySummary {
            day: d,
            outcome,
            goal: self.open.goal,
            count: self.open.count,
            streak_after: self.streak,
            per_share: U128(per_share),
            hero: None,
            jackpot: U128(jackpot_set_aside),
            pot_burned: U128(pot_burn),
            stake_slashed: U128(slash),
            pot_after: U128(self.pot),
        });
        self.last_settled = Some(d);
        self.open_day(d + 1);
    }

    fn settle_days(&mut self, n: u32) {
        for _ in 0..n {
            self.settle_open_day();
        }
    }

    /// S5 `auto_settle` (R6: ERR_BACKLOG, then ERR_LOW_GAS, before any work).
    fn auto_settle(&mut self, today: u32, low_gas: bool) -> Result<(), Errs> {
        let pending = today - self.next();
        if pending > AUTO_SETTLE_CAP {
            return Err(vec![ERR_BACKLOG]);
        }
        if pending > 0 && self.open_succeeds() && low_gas {
            return Err(vec![ERR_LOW_GAS]);
        }
        self.settle_days(pending);
        Ok(())
    }

    /// S5 `settle(max_days)`.
    fn settle(&mut self, today: u32, max_days: Option<u32>, low_gas: bool) -> Result<u32, Errs> {
        let n = (today - self.next())
            .min(max_days.unwrap_or(MAX_SETTLE_DAYS))
            .min(MAX_SETTLE_DAYS);
        if n > 0 && self.open_succeeds() && low_gas {
            return Err(vec![ERR_LOW_GAS]);
        }
        self.settle_days(n);
        Ok(n)
    }

    /// S13 `join` (deposit in yocto; `key_ok`: the key is ed25519 or absent).
    fn join(
        &mut self,
        today: u32,
        low_gas: bool,
        a: &AccountId,
        key: Option<PublicKey>,
        key_ok: bool,
        deposit: u128,
    ) -> Result<(), Errs> {
        self.auto_settle(today, low_gas)?;
        let stake = self.cfg.join_stake.0;
        let msd = self.cfg.member_storage_deposit.0;
        let mut errs = Vec::new();
        if self.members.contains_key(a) {
            errs.push(ERR_ALREADY_MEMBER);
        }
        if !key_ok {
            errs.push(ERR_BAD_KEY);
        }
        if !self.registered(a) {
            errs.push(ERR_NOT_REGISTERED);
        } else if self.balance(a) < stake {
            errs.push(ERR_INSUFFICIENT_BALANCE);
        }
        if deposit < msd {
            errs.push(ERR_STORAGE_DEPOSIT);
        }
        if !errs.is_empty() {
            return Err(errs);
        }
        self.transfer(a, &contract_id(), stake);
        self.stake_pool += stake;
        self.members_total += 1;
        self.members.insert(
            a.clone(),
            MemberModel {
                stake,
                claimable: 0,
                join_day: today,
                activation_day: today + self.cfg.warmup_days,
                last_checkin: None,
                checkins: 0,
                personal_streak: 0,
                best_personal_streak: 0,
                hero_count: 0,
                storage_deposit: msd,
                checkin_key: key,
            },
        );
        if deposit > msd {
            self.out.transfers.push((a.clone(), Some(deposit - msd)));
        }
        self.out.events.push(event(
            "join",
            serde_json::json!({
                "account_id": a,
                "stake": stake.to_string(),
                "activation_day": today + self.cfg.warmup_days,
            }),
        ));
        Ok(())
    }

    /// S7 on `today == open.day` at block height `h`.
    fn do_check_in(
        &mut self,
        today: u32,
        a: &AccountId,
        h: u64,
        via: &str,
    ) -> Result<CheckInResult, Errs> {
        let Some(mm) = self.members.get(a) else {
            return Err(vec![ERR_NOT_MEMBER]);
        };
        if mm.activation_day > today {
            return Err(vec![ERR_WARMUP]);
        }
        if mm.last_checkin == Some(today) {
            return Err(vec![ERR_ALREADY_CHECKED_IN]);
        }
        let mm = self.members.get_mut(a).expect("member");
        mm.personal_streak = if today > 0 && mm.last_checkin == Some(today - 1) {
            mm.personal_streak + 1
        } else {
            1
        };
        mm.best_personal_streak = mm.best_personal_streak.max(mm.personal_streak);
        mm.last_checkin = Some(today);
        mm.checkins += 1;
        let stake = mm.stake;
        let k = self.cfg.closers_k as usize;
        let open = &mut self.open;
        open.count += 1;
        open.checked_stake += stake;
        let in_closers = open.goal > 0 && open.count <= open.goal && h != open.closer_height;
        if in_closers {
            open.closers.push(a.clone());
            if open.closers.len() > k {
                open.closers.remove(0);
            }
            open.closer_height = h;
        }
        let result = CheckInResult {
            day: today,
            n: open.count,
            goal: open.goal,
            in_closers,
        };
        self.out.events.push(event(
            "check_in",
            serde_json::json!({
                "account_id": a,
                "day": today,
                "n": result.n,
                "goal": result.goal,
                "in_closers": in_closers,
                "via": via,
            }),
        ));
        Ok(result)
    }

    fn check_in(
        &mut self,
        today: u32,
        low_gas: bool,
        a: &AccountId,
        h: u64,
    ) -> Result<CheckInResult, Errs> {
        self.auto_settle(today, low_gas)?;
        self.do_check_in(today, a, h, "direct")
    }

    /// S12; `sig_ok`: the signature verifies for (`a`, `day`, the member's current key).
    fn check_in_signed(
        &mut self,
        today: u32,
        low_gas: bool,
        a: &AccountId,
        day: u32,
        sig_ok: bool,
        h: u64,
    ) -> Result<CheckInResult, Errs> {
        self.auto_settle(today, low_gas)?;
        let Some(mm) = self.members.get(a) else {
            return Err(vec![ERR_NOT_MEMBER]);
        };
        if mm.checkin_key.is_none() {
            return Err(vec![ERR_NO_CHECKIN_KEY]);
        }
        if day != today {
            return Err(vec![ERR_BAD_DAY]);
        }
        if !sig_ok {
            return Err(vec![ERR_BAD_SIGNATURE]);
        }
        self.do_check_in(today, a, h, "signed")
    }

    fn claim(
        &mut self,
        today: u32,
        low_gas: bool,
        a: &AccountId,
        deposit: u128,
    ) -> Result<u128, Errs> {
        if deposit != 1 {
            return Err(vec![ERR_ONE_YOCTO]);
        }
        self.auto_settle(today, low_gas)?;
        let Some(mm) = self.members.get_mut(a) else {
            return Err(vec![ERR_NOT_MEMBER]);
        };
        let amount = mm.claimable;
        if amount == 0 {
            return Err(vec![ERR_NOTHING_TO_CLAIM]);
        }
        mm.claimable = 0;
        self.reserved -= amount;
        self.transfer(&contract_id(), a, amount);
        self.out.events.push(event(
            "claim",
            serde_json::json!({ "account_id": a, "amount": amount.to_string() }),
        ));
        Ok(amount)
    }

    /// S10 after the auto-settle; returns (`stake − fee`, burned, bounty).
    fn exit(
        &mut self,
        today: u32,
        a: &AccountId,
        kick_by: Option<&AccountId>,
    ) -> (u128, u128, u128) {
        let mm = self.members.remove(a).expect("member");
        let s = mm.stake;
        let fee = if mm.activation_day <= today {
            let checked = mm.last_checkin == Some(today);
            let fee = if checked { 0 } else { s * self.b() / B };
            self.active_count -= 1;
            self.active_stake = self.active_stake.saturating_sub(s);
            self.open.active_stake = self.open.active_stake.saturating_sub(s);
            if checked {
                self.open.checked_stake -= s;
                self.open.forfeited += 1;
            }
            fee
        } else {
            0
        };
        self.stake_pool -= s;
        let bounty = match kick_by {
            Some(caller) if self.registered(caller) => {
                fee * u128::from(self.cfg.kick_bounty_bps) / B
            }
            _ => 0,
        };
        let burn = fee - bounty;
        if burn > 0 {
            self.burn(burn);
        }
        if let Some(caller) = kick_by {
            self.transfer(&contract_id(), caller, bounty);
        }
        self.reserved -= mm.claimable;
        self.transfer(&contract_id(), a, mm.claimable + s - fee);
        self.members_total -= 1;
        if self.members_total == 0 {
            self.pot += self.stake_pool;
            self.stake_pool = 0;
            self.active_stake = 0;
            self.open.active_stake = 0;
            self.open.checked_stake = 0;
        }
        if mm.storage_deposit > 0 {
            self.out
                .transfers
                .push((a.clone(), Some(mm.storage_deposit)));
        }
        let returned = (s - fee).to_string();
        self.out.events.push(match kick_by {
            None => event(
                "leave",
                serde_json::json!({
                    "account_id": a,
                    "returned": returned,
                    "fee_burned": burn.to_string(),
                }),
            ),
            Some(by) => event(
                "kick",
                serde_json::json!({
                    "account_id": a,
                    "by": by,
                    "returned": returned,
                    "fee_burned": burn.to_string(),
                    "bounty": bounty.to_string(),
                }),
            ),
        });
        (s - fee, burn, bounty)
    }

    fn leave(
        &mut self,
        today: u32,
        low_gas: bool,
        a: &AccountId,
        deposit: u128,
    ) -> Result<u128, Errs> {
        if deposit != 1 {
            return Err(vec![ERR_ONE_YOCTO]);
        }
        self.auto_settle(today, low_gas)?;
        if !self.members.contains_key(a) {
            return Err(vec![ERR_NOT_MEMBER]);
        }
        Ok(self.exit(today, a, None).0)
    }

    /// S10 kick condition.
    pub fn kickable(&self, mm: &MemberModel, today: u32) -> bool {
        let since = mm.last_checkin.map_or(mm.activation_day, |p| p + 1);
        mm.activation_day <= today && today >= since + self.cfg.inactive_days
    }

    fn kick(
        &mut self,
        today: u32,
        low_gas: bool,
        caller: &AccountId,
        a: &AccountId,
    ) -> Result<u128, Errs> {
        self.auto_settle(today, low_gas)?;
        let Some(mm) = self.members.get(a) else {
            return Err(vec![ERR_NOT_MEMBER]);
        };
        if !self.kickable(mm, today) {
            return Err(vec![ERR_NOT_INACTIVE]);
        }
        Ok(self.exit(today, a, Some(caller)).2)
    }

    /// S11 `pick_hero` with the block's random seed.
    fn pick_hero(&mut self, day: u32, seed: &[u8; 32]) {
        let Some(i) = self.pending_heroes.iter().position(|p| p.day == day) else {
            return;
        };
        let p = self.pending_heroes.remove(i);
        self.jackpot_pending -= p.jackpot;
        if p.closers.is_empty() {
            self.pot += p.jackpot;
            return;
        }
        let mut preimage = seed.to_vec();
        preimage.extend_from_slice(&day.to_le_bytes());
        preimage.extend_from_slice(b"lastcall");
        let hash = env::sha256(&preimage);
        let mut prefix = [0u8; 8];
        prefix.copy_from_slice(&hash[..8]);
        let hero =
            p.closers[(u64::from_le_bytes(prefix) % p.closers.len() as u64) as usize].clone();
        let paid = self.registered(&hero);
        self.out.events.push(event(
            "hero",
            serde_json::json!({
                "day": day,
                "account_id": &hero,
                "jackpot": p.jackpot.to_string(),
                "paid": paid,
            }),
        ));
        if paid {
            self.transfer(&contract_id(), &hero, p.jackpot);
            self.total_jackpots += p.jackpot;
            if let Some(mm) = self.members.get_mut(&hero) {
                mm.hero_count += 1;
            }
        } else {
            self.pot += p.jackpot;
        }
        // The ring holds the day only while it is among the last HISTORY_LEN settled days.
        let in_ring = day + HISTORY_LEN >= self.next();
        if let Some(summary) = self.days.get_mut(day as usize)
            && in_ring
        {
            summary.hero = Some(hero);
        }
    }

    fn retry_pick_hero(&mut self, day: u32, low_gas: bool) -> Result<(), Errs> {
        if !self.pending_heroes.iter().any(|p| p.day == day) {
            return Err(vec![ERR_NO_PENDING_HERO]);
        }
        if low_gas {
            return Err(vec![ERR_LOW_GAS]);
        }
        self.out.pick_hero.push(day);
        Ok(())
    }

    fn ft_transfer(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        amount: u128,
        deposit: u128,
    ) -> Result<(), Errs> {
        if *to == contract_id() {
            return Err(vec![ERR_USE_JOIN]);
        }
        if deposit != 1 {
            return Err(vec![std_err::ONE_YOCTO]);
        }
        let mut errs = Vec::new();
        if from == to {
            errs.push(std_err::SAME);
        }
        if amount == 0 {
            errs.push(std_err::ZERO);
        }
        if !self.registered(from) {
            errs.push(std_err::NOT_REGISTERED);
        } else if self.balance(from) < amount {
            errs.push(std_err::NOT_ENOUGH);
        }
        if !self.registered(to) {
            errs.push(std_err::NOT_REGISTERED);
        }
        if !errs.is_empty() {
            return Err(errs);
        }
        self.transfer(from, to, amount);
        Ok(())
    }

    fn storage_unregister(
        &mut self,
        a: &AccountId,
        force: bool,
        deposit: u128,
    ) -> Result<bool, Errs> {
        if self.members.contains_key(a) {
            return Err(vec![ERR_MEMBER_CANNOT_UNREGISTER]);
        }
        if deposit != 1 {
            return Err(vec![std_err::ONE_YOCTO]);
        }
        let Some(&balance) = self.balances.get(a) else {
            return Ok(false);
        };
        if balance > 0 && !force {
            return Err(vec![std_err::POSITIVE_BALANCE]);
        }
        self.balances.remove(a);
        self.supply -= balance;
        self.total_burned += balance;
        self.out.transfers.push((a.clone(), None));
        Ok(true)
    }

    fn faucet(&mut self, a: &AccountId) -> Result<u128, Errs> {
        let amount = self.cfg.faucet_amount.0;
        if amount == 0 {
            return Err(vec![ERR_FAUCET_DISABLED]);
        }
        if self.faucet_used.contains(a) {
            return Err(vec![ERR_FAUCET_USED]);
        }
        if !self.registered(a) {
            return Err(vec![ERR_NOT_REGISTERED]);
        }
        if self.faucet_left < amount {
            return Err(vec![ERR_FAUCET_EMPTY]);
        }
        self.transfer(&contract_id(), a, amount);
        self.faucet_left -= amount;
        self.faucet_used.insert(a.clone());
        self.out.events.push(event(
            "faucet",
            serde_json::json!({ "account_id": a, "amount": amount.to_string() }),
        ));
        Ok(amount)
    }

    fn set_checkin_key(
        &mut self,
        a: &AccountId,
        key: Option<PublicKey>,
        key_ok: bool,
        deposit: u128,
    ) -> Result<(), Errs> {
        if deposit != 1 {
            return Err(vec![ERR_ONE_YOCTO]);
        }
        let mut errs = Vec::new();
        if !self.members.contains_key(a) {
            errs.push(ERR_NOT_MEMBER);
        }
        if !key_ok {
            errs.push(ERR_BAD_KEY);
        }
        if !errs.is_empty() {
            return Err(errs);
        }
        self.members.get_mut(a).expect("member").checkin_key = key;
        Ok(())
    }

    /// `register_and_fund` of the harness: register, then `owner → a`.
    fn fund(&mut self, a: &AccountId, amount: u128) {
        self.balances.entry(a.clone()).or_insert(0);
        self.transfer(&owner(), a, amount);
    }
}

// ---- Keys ----

/// A deterministic ed25519 key pair and its `PublicKey`.
pub(crate) fn key_pair(seed: u64) -> (SigningKey, PublicKey) {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&seed.to_le_bytes());
    bytes[31] = 0x5a;
    let sk = SigningKey::from_bytes(&bytes);
    let mut pk = vec![0u8];
    pk.extend_from_slice(sk.verifying_key().as_bytes());
    (sk, PublicKey::try_from(pk).expect("ed25519 key"))
}

/// A secp256k1-shaped key: `ERR_BAD_KEY`.
pub(crate) fn bad_key() -> PublicKey {
    let mut bytes = vec![1u8];
    bytes.extend([7u8; 64]);
    PublicKey::try_from(bytes).expect("secp256k1 key shape")
}

/// NEP-413 signature of the check-in message (S12), recipient = the contract.
pub(crate) fn sign_check_in(
    sk: &SigningKey,
    account: &AccountId,
    day: u32,
    nonce: [u8; 32],
) -> Vec<u8> {
    let message = format!(r#"{{"action":"check_in","account_id":"{account}","day":{day}}}"#);
    let recipient = contract_id().to_string();
    let mut payload = 2_147_484_061u32.to_le_bytes().to_vec();
    payload.extend((message.len() as u32).to_le_bytes());
    payload.extend(message.as_bytes());
    payload.extend(nonce);
    payload.extend((recipient.len() as u32).to_le_bytes());
    payload.extend(recipient.as_bytes());
    payload.push(0);
    sk.sign(&env::sha256(&payload)).to_bytes().to_vec()
}

// ---- World ----

/// One check-in of the journal (I5, I6).
#[derive(Clone, Debug)]
pub(crate) struct CheckInRec {
    pub account: AccountId,
    pub day: u32,
    pub height: u64,
    pub result: CheckInResult,
}

/// Counters of the calls made, per method and outcome (printed by the fuzz).
#[derive(Clone, Debug, Default)]
pub(crate) struct Stats {
    pub calls: BTreeMap<String, u64>,
    /// Largest `stake_pool − Σ effective stakes` seen (R1 dust, I3).
    pub max_dust: u128,
    /// Largest `active_stake − Σ active effective stakes` seen.
    pub max_active_dust: u128,
}

impl Stats {
    pub fn add(&mut self, method: &str, outcome: &str) {
        *self
            .calls
            .entry(format!("{method}: {outcome}"))
            .or_insert(0) += 1;
    }

    pub fn merge(&mut self, other: &Stats) {
        for (k, v) in &other.calls {
            *self.calls.entry(k.clone()).or_insert(0) += v;
        }
        self.max_dust = self.max_dust.max(other.max_dust);
        self.max_active_dust = self.max_active_dust.max(other.max_active_dust);
    }
}

pub(crate) struct World {
    pub c: Contract,
    pub m: Model,
    pub ctx: Ctx,
    /// Each call in a new block (height + 1) unless false (a batch in one block).
    pub auto_block: bool,
    /// The next calls run with `LOW_GAS` prepaid.
    pub low_gas: bool,
    /// Logs and receipts of the last successful call.
    pub logs: Vec<String>,
    pub receipts: Receipts,
    /// Check-ins of every day (I5, I6).
    pub journal: Vec<CheckInRec>,
    checked: BTreeSet<(AccountId, u32)>,
    /// Every account seen, to compare FT registration with the model.
    accounts: BTreeSet<AccountId>,
    prev_supply: u128,
    prev_burned: u128,
    prev_last_settled: Option<u32>,
    pub stats: Stats,
    /// Full checks (history ring, failed bits, rewards records) on every call, not only per day.
    pub thorough: bool,
}

impl World {
    pub fn new(set: &str) -> World {
        World::deploy(crate::test_utils::params(set))
    }

    /// Deploys with `p` at `LAUNCH_NS` (day 0, height 1), `initial_holder = owner()`.
    pub fn deploy(p: ParamSet) -> World {
        install_quiet_hook();
        let ctx = Ctx {
            launch_ns: LAUNCH_NS,
            day_length_s: p.config.day_length_s,
            timestamp_ns: LAUNCH_NS,
            height: 1,
            seed: [0; 32],
            predecessor: owner(),
            deposit: 0,
            prepaid_gas: FULL_GAS,
        };
        ctx.install(HashMap::new(), 0);
        let c = Contract::new(
            p.config.clone(),
            p.total_supply,
            p.pot_bps,
            p.faucet_bps,
            owner(),
            metadata(),
        );
        let m = Model::new(&p);
        let mut w = World {
            c,
            prev_supply: m.supply,
            m,
            ctx,
            auto_block: true,
            low_gas: false,
            logs: Vec::new(),
            receipts: Receipts::default(),
            journal: Vec::new(),
            checked: BTreeSet::new(),
            accounts: [contract_id(), owner()].into_iter().collect(),
            prev_last_settled: None,
            prev_burned: 0,
            stats: Stats::default(),
            thorough: true,
        };
        w.check();
        w
    }

    // ---- time ----

    pub fn today(&self) -> u32 {
        ((self.ctx.timestamp_ns - self.ctx.launch_ns) / (self.ctx.day_length_s * 1_000_000_000))
            as u32
    }

    /// Moves the clock to `day` + `offset_s` (never back) and to the next block.
    pub fn goto(&mut self, day: u32, offset_s: u64) {
        let ts = self.ctx.launch_ns
            + (u64::from(day) * self.ctx.day_length_s + offset_s) * 1_000_000_000;
        assert!(ts >= self.ctx.timestamp_ns, "time never goes back");
        let new_day = day != self.today();
        self.ctx.timestamp_ns = ts;
        self.ctx.height += 1;
        if new_day {
            // Views read the clock of the mocked context.
            self.ctx.apply();
            self.check_full();
        }
    }

    pub fn next_block(&mut self) {
        self.ctx.height += 1;
    }

    // ---- accounts ----

    /// Registers `a` in the token (if needed) and moves `amount` from `owner()` (harness-style, no
    /// contract method).
    pub fn fund(&mut self, a: &AccountId, amount: u128) {
        self.accounts.insert(a.clone());
        self.ctx.apply();
        crate::test_utils::register_and_fund(&mut self.c, a, amount);
        self.m.fund(a, amount);
    }

    pub fn member(&self, a: &AccountId) -> Option<&MemberModel> {
        self.m.members.get(a)
    }

    pub fn balance(&self, a: &AccountId) -> u128 {
        self.c.token.accounts.get(a).unwrap_or(0)
    }

    // ---- calls ----

    /// Runs `f` as one receipt from `who` with `deposit` (yocto). A panic is rolled back and
    /// returned as the contract's error string; `prework` lists the errors that must leave the
    /// state untouched even before the rollback (R6, S13).
    fn exec<T>(
        &mut self,
        who: &AccountId,
        deposit: u128,
        prework: &[&str],
        f: impl FnOnce(&mut Contract) -> T,
    ) -> Result<T, String> {
        if self.auto_block {
            self.ctx.height += 1;
        }
        self.logs.clear();
        self.receipts = Receipts::default();
        self.accounts.insert(who.clone());
        self.ctx.predecessor = who.clone();
        self.ctx.deposit = deposit;
        self.ctx.prepaid_gas = if self.low_gas { LOW_GAS } else { FULL_GAS };
        let snap = self.snapshot();
        QUIET.with(|q| q.set(true));
        let result = catch_unwind(AssertUnwindSafe(|| f(&mut self.c)));
        QUIET.with(|q| q.set(false));
        let out = match result {
            Ok(value) => {
                self.logs = get_logs();
                self.receipts = receipts_of_call();
                Ok(value)
            }
            Err(payload) => {
                let message = panic_text(payload);
                let err = error_of(&message);
                if prework.contains(&err.as_str()) {
                    assert!(
                        self.unchanged_since(&snap),
                        "{err} must be raised before any work (R6/S13), but the state changed"
                    );
                }
                self.restore(snap);
                Err(message)
            }
        };
        // Checks run with full gas in a fresh context.
        self.ctx.prepaid_gas = FULL_GAS;
        self.ctx.deposit = 0;
        self.ctx.apply();
        out
    }

    fn snapshot(&mut self) -> Snapshot {
        flush(&mut self.c);
        let root = borsh::to_vec(&self.c).expect("contract borsh");
        let usage = env::storage_usage();
        let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let snap = Snapshot {
            root,
            storage: storage.clone(),
            usage,
        };
        self.ctx.install(storage, usage);
        snap
    }

    fn unchanged_since(&mut self, snap: &Snapshot) -> bool {
        flush(&mut self.c);
        let root = borsh::to_vec(&self.c).expect("contract borsh");
        let usage = env::storage_usage();
        let storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
        let same = root == snap.root && usage == snap.usage && storage == snap.storage;
        self.ctx.install(storage, usage);
        same
    }

    fn restore(&mut self, snap: Snapshot) {
        let restored: Contract = borsh::from_slice(&snap.root).expect("contract borsh");
        // Dropping the failed call's contract flushes its caches into the mock; discarded below.
        drop(std::mem::replace(&mut self.c, restored));
        self.ctx.install(snap.storage, snap.usage);
    }

    /// Runs a call and its model twin and compares them: the same success value, or an error from
    /// the model's list. On success the model advances, then all checks run.
    fn run<T: PartialEq + std::fmt::Debug>(
        &mut self,
        method: &str,
        who: &AccountId,
        deposit: u128,
        model: impl FnOnce(&mut Model) -> Result<T, Errs>,
        call: impl FnOnce(&mut Contract) -> T,
    ) -> Result<T, String> {
        self.run_then(method, who, deposit, model, call, |_, _| {})
    }

    /// `run` with `on_ok` called after a success, before the checks (the check-in journal).
    fn run_then<T: PartialEq + std::fmt::Debug>(
        &mut self,
        method: &str,
        who: &AccountId,
        deposit: u128,
        model: impl FnOnce(&mut Model) -> Result<T, Errs>,
        call: impl FnOnce(&mut Contract) -> T,
        on_ok: impl FnOnce(&mut World, &T),
    ) -> Result<T, String> {
        let mut next = self.m.clone();
        next.out = Receipts::default();
        let expected = model(&mut next);
        let prework = [ERR_ONE_YOCTO, ERR_BACKLOG, ERR_LOW_GAS];
        let low_gas = self.low_gas;
        let actual = self.exec(who, deposit, &prework, call);
        let ctx = format!(
            "{method} by {who} on day {} (height {}, next {}, low_gas {low_gas})",
            self.today(),
            self.ctx.height,
            self.m.next()
        );
        match (expected, actual) {
            (Ok(want), Ok(got)) => {
                assert_eq!(got, want, "{ctx}: return value differs from the model");
                assert_eq!(
                    self.receipts, next.out,
                    "{ctx}: receipts differ from the model"
                );
                assert_eq!(
                    game_events(&self.logs),
                    next.out.events,
                    "{ctx}: lastcall events differ from the model (S15)"
                );
                self.m = next;
                self.stats.add(method, "ok");
                on_ok(self, &got);
                self.after_success(method, &ctx);
                Ok(got)
            }
            (Err(errs), Err(message)) => {
                let err = error_of(&message);
                assert!(
                    errs.iter().any(|e| err.contains(e)),
                    "{ctx}: error {message:?}, the model expects one of {errs:?}"
                );
                self.stats.add(method, errs[0]);
                self.check();
                Err(err)
            }
            (Ok(want), Err(message))
                if low_gas && (message.contains(std_err::GAS) || message.contains("GasLimit")) =>
            {
                // Low prepaid gas without ERR_LOW_GAS may simply run out (rolled back).
                let _ = want;
                self.stats.add(method, "out of gas");
                self.check();
                Err(message)
            }
            (Ok(want), Err(message)) => {
                panic!("{ctx}: unexpected error {message:?}, the model expects Ok({want:?})")
            }
            (Err(errs), Ok(got)) => {
                panic!("{ctx}: succeeded with {got:?}, the model expects one of {errs:?}")
            }
        }
    }

    fn after_success(&mut self, method: &str, ctx: &str) {
        let today = self.today();
        let game = matches!(
            method,
            "join" | "check_in" | "check_in_signed" | "claim" | "leave" | "kick"
        );
        if game {
            // I9: a game call settles everything before today.
            assert_eq!(self.c.last_settled, today.checked_sub(1), "{ctx}: I9");
        }
        // S15: logs within the runtime limits; at most one ft_burn and one days_settled from the
        // settle part, `days_settled` runs ≤ warmup_days + 2.
        assert!(self.logs.len() <= 100, "{ctx}: more than 100 logs");
        let bytes: usize = self.logs.iter().map(String::len).sum();
        assert!(bytes <= 16_384, "{ctx}: {bytes} bytes of logs");
        let settled = self.c.last_settled != self.prev_last_settled;
        let days_settled: Vec<serde_json::Value> = self
            .logs
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
            .filter(|e| e["event"] == "days_settled")
            .collect();
        assert_eq!(
            days_settled.len(),
            usize::from(settled),
            "{ctx}: one days_settled per settling call"
        );
        if let Some(e) = days_settled.first() {
            let runs = e["data"]["runs"].as_array().map_or(0, Vec::len);
            assert!(
                runs as u32 <= self.m.cfg.warmup_days + 2,
                "{ctx}: {runs} runs > warmup_days + 2"
            );
            let from = self.prev_last_settled.map_or(0, |d| d + 1);
            let to = self.m.next();
            assert_eq!(
                e["data"]["runs"],
                expected_runs(&self.m.days[from as usize..to as usize]),
                "{ctx}: days_settled runs (S15)"
            );
        }
        // S15: every burn has its ft_burn event.
        let burned: u128 = self
            .logs
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
            .filter(|e| e["standard"] == "nep141" && e["event"] == "ft_burn")
            .flat_map(|e| e["data"].as_array().cloned().unwrap_or_default())
            .map(|d| {
                d["amount"]
                    .as_str()
                    .expect("amount")
                    .parse::<u128>()
                    .expect("u128")
            })
            .sum();
        assert_eq!(
            burned,
            self.m.total_burned - self.prev_burned,
            "{ctx}: ft_burn events vs total_burned"
        );
        let mints = self
            .logs
            .iter()
            .filter(|l| l.contains("\"event\":\"ft_mint\""))
            .count();
        assert_eq!(mints, 0, "{ctx}: ft_mint after new (I2)");
        self.check();
    }

    /// Model equality, `assert_invariants` and the journal checks (cheap part, every call).
    pub fn check(&mut self) {
        let c = &self.c;
        let m = &self.m;
        let today = self.today();
        // Buckets and aggregates.
        assert_eq!(
            (
                c.pot,
                c.reserved,
                c.stake_pool,
                c.faucet_left,
                c.jackpot_pending
            ),
            (
                m.pot,
                m.reserved,
                m.stake_pool,
                m.faucet_left,
                m.jackpot_pending
            ),
            "model: pot, reserved, stake_pool, faucet_left, jackpot_pending"
        );
        assert_eq!(
            (c.last_settled, c.streak, c.longest_streak),
            (m.last_settled, m.streak, m.longest_streak),
            "model: last_settled, streak, longest_streak"
        );
        assert_eq!(
            (c.active_count, c.active_stake, c.members_total),
            (m.active_count, m.active_stake, m.members_total),
            "model: active_count, active_stake, members_total"
        );
        assert_eq!(c.open, m.open, "model: open day");
        assert_eq!(c.pending_heroes, m.pending_heroes, "model: pending heroes");
        assert_eq!(
            (
                c.total_burned,
                c.total_rewarded,
                c.total_jackpots,
                c.token.total_supply
            ),
            (m.total_burned, m.total_rewarded, m.total_jackpots, m.supply),
            "model: total_burned, total_rewarded, total_jackpots, total_supply"
        );
        assert_eq!(c.initial_supply, m.initial_supply, "model: initial_supply");
        assert_eq!(m.supply, m.initial_supply - m.total_burned, "model: I2");
        // I7: no way to change the config.
        assert_eq!(c.config, m.cfg, "I7: config changed");
        // I2: the supply never grows.
        assert!(c.token.total_supply <= self.prev_supply, "I2: supply grew");
        self.prev_supply = c.token.total_supply;
        // I7/I9: settled days are final.
        assert!(
            c.last_settled >= self.prev_last_settled,
            "I7: last_settled went back"
        );
        // R1 dust (I3 itself is in `assert_invariants`).
        let all: u128 = m.members.values().map(|mm| mm.stake).sum();
        let active: u128 = m
            .members
            .values()
            .filter(|mm| mm.activation_day <= m.open.day)
            .map(|mm| mm.stake)
            .sum();
        if let (Some(d), Some(da)) = (
            c.stake_pool.checked_sub(all),
            c.active_stake.checked_sub(active),
        ) {
            self.stats.max_dust = self.stats.max_dust.max(d);
            self.stats.max_active_dust = self.stats.max_active_dust.max(da);
        }
        // Members through the view (resolve_pure with t = next).
        assert_eq!(
            c.members.len() as usize,
            m.members.len(),
            "model: member count"
        );
        for (a, mm) in &m.members {
            let v =
                views::get_member(c, a.clone()).unwrap_or_else(|| panic!("model: {a} is a member"));
            let since = mm.last_checkin.map_or(mm.activation_day, |p| p + 1);
            let active = mm.activation_day <= today;
            let checked_today = mm.last_checkin == Some(today);
            let got = (
                v.effective_stake.0,
                v.pending_claimable.0,
                v.join_day,
                v.activation_day,
                v.last_checkin,
                v.checkins,
                v.personal_streak,
                v.best_personal_streak,
                v.hero_count,
                v.storage_deposit.0,
                v.checkin_key.clone(),
            );
            let want = (
                mm.stake,
                mm.claimable,
                mm.join_day,
                mm.activation_day,
                mm.last_checkin,
                mm.checkins,
                mm.personal_streak,
                mm.best_personal_streak,
                mm.hero_count,
                mm.storage_deposit,
                mm.checkin_key.clone(),
            );
            assert_eq!(got, want, "model: member {a} (view vs eager model)");
            // S14 derived fields.
            assert_eq!(v.is_active, active, "view {a}: is_active");
            assert_eq!(
                v.checked_in_today, checked_today,
                "view {a}: checked_in_today"
            );
            assert_eq!(v.can_check_in_today, active && !checked_today, "view {a}");
            assert_eq!(
                v.kickable_from_day,
                active.then_some(since + m.cfg.inactive_days),
                "view {a}: kickable_from_day"
            );
            let alive = mm.last_checkin.is_some_and(|p| p + 1 >= today);
            assert_eq!(
                v.current_personal_streak,
                if alive { mm.personal_streak } else { 0 },
                "view {a}: current_personal_streak"
            );
        }
        // FT balances and registrations.
        for a in &self.accounts {
            assert_eq!(
                c.token.accounts.get(a),
                m.balances.get(a).copied(),
                "model: FT balance of {a}"
            );
        }
        // get_state.
        let s = views::get_state(c);
        let day_ns = self.ctx.day_length_s * 1_000_000_000;
        let end = self.ctx.launch_ns + (u64::from(today) + 1) * day_ns;
        assert_eq!(
            s.ms_to_day_end,
            (end - self.ctx.timestamp_ns) / 1_000_000,
            "get_state: ms_to_day_end"
        );
        assert_eq!(
            (s.today, s.pending_days),
            (today, today - m.next()),
            "get_state"
        );
        assert_eq!(
            s.pending_hero_days,
            m.pending_heroes.iter().map(|p| p.day).collect::<Vec<_>>(),
            "get_state: pending_hero_days"
        );
        // I6 from the journal: the closers of the open day are the last ≤ K candidates
        // (number ≤ goal, first check-in of its block).
        let mut candidates: Vec<(AccountId, u64)> = Vec::new();
        let start = self.journal.partition_point(|r| r.day < m.open.day);
        for r in &self.journal[start..] {
            let first_of_block = candidates.last().is_none_or(|(_, h)| *h != r.height);
            let candidate = r.result.goal > 0 && r.result.n <= r.result.goal && first_of_block;
            assert_eq!(
                r.result.in_closers, candidate,
                "I6: in_closers of {}",
                r.account
            );
            if candidate {
                candidates.push((r.account.clone(), r.height));
            }
        }
        let k = m.cfg.closers_k as usize;
        let tail = &candidates[candidates.len().saturating_sub(k)..];
        assert_eq!(
            c.open.closers,
            tail.iter().map(|(a, _)| a.clone()).collect::<Vec<_>>(),
            "I6: closers vs journal"
        );
        let heights: BTreeSet<u64> = tail.iter().map(|(_, h)| *h).collect();
        assert_eq!(heights.len(), tail.len(), "I6: candidate heights differ");
        if self.thorough {
            self.check_history();
        }
        // get_open_day.
        let o = views::get_open_day(&self.c);
        assert_eq!(
            (
                o.day,
                o.goal,
                o.count,
                o.active,
                o.forfeited,
                o.is_idle,
                o.stale
            ),
            (
                self.m.open.day,
                self.m.open.goal,
                self.m.open.count,
                self.m.open.active,
                self.m.open.forfeited,
                self.m.open.goal == 0,
                self.m.open.day < today
            ),
            "get_open_day"
        );
        assert_invariants(&self.c);
        self.prev_last_settled = self.c.last_settled;
        self.prev_burned = self.m.total_burned;
    }

    /// History ring, failed bits and rewards records of every settled day (I7, I8, I10).
    fn check_history(&self) {
        let c = &self.c;
        let next = self.m.next();
        for d in next.saturating_sub(HISTORY_LEN)..next {
            assert_eq!(
                c.history.get(&(d % HISTORY_LEN)),
                Some(&self.m.days[d as usize]),
                "I7: history of day {d}"
            );
        }
        for d in 0..next {
            let summary = &self.m.days[d as usize];
            assert_eq!(
                bits::is_set(&c.failed_bits, d),
                summary.outcome == Outcome::Fail,
                "failed bit of day {d}"
            );
            // I10 without the candidate list: a record exists only for a successful day with a
            // share, and its refs are exactly the members still holding a reference.
            let refs = c
                .members
                .values()
                .filter(|mm| mm.last_checkin == Some(d) && mm.resolved_through <= d)
                .count() as u32;
            match c.rewards.get(&d) {
                Some(r) => {
                    assert_eq!(summary.outcome, Outcome::Success, "I10: record of day {d}");
                    assert_eq!(r.per_share, summary.per_share.0, "I8/I10: per_share of {d}");
                    assert!(r.per_share > 0, "I8: record with per_share 0");
                    assert_eq!(r.refs, refs, "I10: refs of day {d}");
                }
                None => assert!(
                    refs == 0 || summary.outcome != Outcome::Success || summary.per_share.0 == 0,
                    "I10: day {d} lost its record with {refs} references"
                ),
            }
        }
    }

    /// Full checks, also when `thorough` is off (once per day in the fuzz).
    pub fn check_full(&mut self) {
        self.check_history();
        let next = self.m.next() as usize;
        let want: Vec<DaySummary> = self.m.days[next.saturating_sub(HISTORY_LEN as usize)..]
            .iter()
            .rev()
            .cloned()
            .collect();
        assert_eq!(views::get_history(&self.c, 100), want, "get_history");
        assert_eq!(
            views::get_history(&self.c, 3),
            want.iter().take(3).cloned().collect::<Vec<_>>(),
            "get_history(3)"
        );
        // get_kickable over pages of 4.
        let today = self.today();
        let mut got = BTreeSet::new();
        let mut from = 0;
        loop {
            let page = views::get_kickable(&self.c, from, 4);
            got.extend(page.accounts);
            match page.next_index {
                Some(n) => from = n,
                None => break,
            }
        }
        let want: BTreeSet<AccountId> = self
            .m
            .members
            .iter()
            .filter(|(_, mm)| self.m.kickable(mm, today))
            .map(|(a, _)| a.clone())
            .collect();
        assert_eq!(got, want, "get_kickable");
    }

    fn record_check_in(&mut self, a: &AccountId, result: CheckInResult) {
        // I5.
        assert!(
            self.checked.insert((a.clone(), result.day)),
            "I5: {a} checked in twice on day {}",
            result.day
        );
        self.journal.push(CheckInRec {
            account: a.clone(),
            day: result.day,
            height: self.ctx.height,
            result,
        });
    }

    // ---- methods ----

    pub fn join(&mut self, a: &AccountId, key: Option<PublicKey>) -> Result<(), String> {
        self.join_with(a, key, DEPOSIT)
    }

    pub fn join_with(
        &mut self,
        a: &AccountId,
        key: Option<PublicKey>,
        deposit: u128,
    ) -> Result<(), String> {
        let (today, low) = (self.today(), self.low_gas);
        let key_ok = key
            .as_ref()
            .is_none_or(|k| k.as_bytes()[0] == 0 && k.as_bytes().len() == 33);
        let k2 = key.clone();
        let who = a.clone();
        self.run(
            "join",
            a,
            deposit,
            |m| m.join(today, low, &who, k2, key_ok, deposit),
            |c| c.join(key),
        )
    }

    /// Registers and funds `a` with `join_stake`, then joins with the exact deposit.
    pub fn fund_and_join(&mut self, a: &AccountId, key: Option<PublicKey>) -> Result<(), String> {
        let stake = self.m.cfg.join_stake.0;
        let have = self.m.balance(a);
        if have < stake || !self.m.registered(a) {
            self.fund(a, stake - have.min(stake));
        }
        self.join(a, key)
    }

    pub fn check_in(&mut self, a: &AccountId) -> Result<CheckInResult, String> {
        let (today, low, h) = (
            self.today(),
            self.low_gas,
            self.ctx.height + u64::from(self.auto_block),
        );
        let who = a.clone();
        let acct = a.clone();
        self.run_then(
            "check_in",
            a,
            0,
            |m| m.check_in(today, low, &who, h),
            |c| c.check_in(),
            |w, r| w.record_check_in(&acct, *r),
        )
    }

    /// `check_in_signed` relayed by `relayer`; `sig_ok` tells the model whether the signature is
    /// valid for (`account`, `day`, its current key).
    pub fn check_in_signed(
        &mut self,
        relayer: &AccountId,
        account: &AccountId,
        day: u32,
        nonce: Vec<u8>,
        signature: Vec<u8>,
        sig_ok: bool,
    ) -> Result<CheckInResult, String> {
        let (today, low, h) = (
            self.today(),
            self.low_gas,
            self.ctx.height + u64::from(self.auto_block),
        );
        let who = account.clone();
        let acct = account.clone();
        let acct2 = account.clone();
        self.run_then(
            "check_in_signed",
            relayer,
            0,
            |m| m.check_in_signed(today, low, &who, day, sig_ok, h),
            |c| {
                c.check_in_signed(
                    acct,
                    day,
                    Base64VecU8::from(nonce),
                    Base64VecU8::from(signature),
                )
            },
            |w, r| w.record_check_in(&acct2, *r),
        )
    }

    pub fn claim(&mut self, a: &AccountId) -> Result<u128, String> {
        self.claim_with(a, 1)
    }

    pub fn claim_with(&mut self, a: &AccountId, deposit: u128) -> Result<u128, String> {
        let (today, low) = (self.today(), self.low_gas);
        let who = a.clone();
        self.run(
            "claim",
            a,
            deposit,
            |m| m.claim(today, low, &who, deposit),
            |c| c.claim().0,
        )
    }

    pub fn leave(&mut self, a: &AccountId) -> Result<u128, String> {
        self.leave_with(a, 1)
    }

    pub fn leave_with(&mut self, a: &AccountId, deposit: u128) -> Result<u128, String> {
        let (today, low) = (self.today(), self.low_gas);
        let who = a.clone();
        self.run(
            "leave",
            a,
            deposit,
            |m| m.leave(today, low, &who, deposit),
            |c| c.leave().0,
        )
    }

    pub fn kick(&mut self, caller: &AccountId, a: &AccountId) -> Result<u128, String> {
        let (today, low) = (self.today(), self.low_gas);
        let (who, target, target2) = (caller.clone(), a.clone(), a.clone());
        self.run(
            "kick",
            caller,
            0,
            |m| m.kick(today, low, &who, &target),
            |c| c.kick(target2).0,
        )
    }

    pub fn settle(&mut self, max_days: Option<u32>) -> Result<u32, String> {
        let (today, low) = (self.today(), self.low_gas);
        let caller: AccountId = "settler.near".parse().expect("id");
        self.run(
            "settle",
            &caller,
            0,
            |m| m.settle(today, max_days, low),
            |c| c.settle(max_days),
        )
    }

    /// `pick_hero(day)` as the runtime runs the promise: from the contract, with `seed`.
    pub fn pick_hero(&mut self, day: u32, seed: [u8; 32]) {
        self.ctx.seed = seed;
        let before = (self.m.pending_heroes.len(), self.m.total_jackpots);
        let r = self.run(
            "pick_hero",
            &contract_id(),
            0,
            |m| {
                m.pick_hero(day, &seed);
                Ok(())
            },
            |c| c.pick_hero(day),
        );
        r.expect("pick_hero never fails");
        let outcome = if self.m.pending_heroes.len() == before.0 {
            "no-op"
        } else if self.m.total_jackpots > before.1 {
            "paid"
        } else {
            "jackpot to the pot"
        };
        self.stats.add("pick_hero", outcome);
    }

    pub fn retry_pick_hero(&mut self, caller: &AccountId, day: u32) -> Result<(), String> {
        let low = self.low_gas;
        self.run(
            "retry_pick_hero",
            caller,
            0,
            |m| m.retry_pick_hero(day, low),
            |c| c.retry_pick_hero(day),
        )
    }

    pub fn ft_transfer(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        amount: u128,
    ) -> Result<(), String> {
        self.accounts.insert(to.clone());
        let (f, t, t2) = (from.clone(), to.clone(), to.clone());
        self.run(
            "ft_transfer",
            from,
            1,
            |m| m.ft_transfer(&f, &t, amount, 1),
            |c| c.ft_transfer(t2, U128(amount), None),
        )
    }

    pub fn storage_unregister(&mut self, a: &AccountId, force: bool) -> Result<bool, String> {
        let who = a.clone();
        self.run(
            "storage_unregister",
            a,
            1,
            |m| m.storage_unregister(&who, force, 1),
            |c| c.storage_unregister(Some(force)),
        )
    }

    pub fn faucet(&mut self, a: &AccountId) -> Result<u128, String> {
        let who = a.clone();
        self.run("faucet", a, 0, |m| m.faucet(&who), |c| c.faucet().0)
    }

    pub fn set_checkin_key(&mut self, a: &AccountId, key: Option<PublicKey>) -> Result<(), String> {
        let key_ok = key
            .as_ref()
            .is_none_or(|k| k.as_bytes()[0] == 0 && k.as_bytes().len() == 33);
        let (who, k2) = (a.clone(), key.clone());
        self.run(
            "set_checkin_key",
            a,
            1,
            |m| m.set_checkin_key(&who, k2, key_ok, 1),
            |c| c.set_checkin_key(key),
        )
    }

    /// Pending `pick_hero` promises created by the last successful call.
    pub fn new_pick_hero_promises(&self) -> Vec<u32> {
        self.receipts.pick_hero.clone()
    }
}

/// S15 `days_settled.runs` of the settled days `days`: consecutive empty days (`count == 0`)
/// with the same outcome and goal form one record (amounts summed, the last day's streak and pot).
fn expected_runs(days: &[DaySummary]) -> serde_json::Value {
    let mut runs: Vec<serde_json::Value> = Vec::new();
    let mut last: Option<&DaySummary> = None;
    for d in days {
        let merge = last.is_some_and(|l| {
            l.count == 0 && d.count == 0 && l.outcome == d.outcome && l.goal == d.goal
        });
        if merge {
            let r = runs.last_mut().expect("a run");
            let add = |v: &serde_json::Value, x: u128| {
                serde_json::json!(
                    (v.as_str().expect("U128").parse::<u128>().expect("u128") + x).to_string()
                )
            };
            r["to_day"] = serde_json::json!(d.day);
            r["streak_after"] = serde_json::json!(d.streak_after);
            r["per_share"] = add(&r["per_share"], d.per_share.0);
            r["jackpot"] = add(&r["jackpot"], d.jackpot.0);
            r["pot_burned"] = add(&r["pot_burned"], d.pot_burned.0);
            r["stake_slashed"] = add(&r["stake_slashed"], d.stake_slashed.0);
            r["pot_after"] = serde_json::json!(d.pot_after.0.to_string());
        } else {
            runs.push(serde_json::json!({
                "from_day": d.day,
                "to_day": d.day,
                "outcome": d.outcome,
                "goal": d.goal,
                "count": d.count,
                "streak_after": d.streak_after,
                "per_share": d.per_share,
                "jackpot": d.jackpot,
                "pot_burned": d.pot_burned,
                "stake_slashed": d.stake_slashed,
                "pot_after": d.pot_after,
            }));
        }
        last = Some(d);
    }
    serde_json::Value::Array(runs)
}

/// The `lastcall` events of a call except `days_settled`, as `{event, data}`.
fn game_events(logs: &[String]) -> Vec<serde_json::Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .filter(|e| e["standard"] == "lastcall" && e["event"] != "days_settled")
        .map(|e| {
            assert_eq!(e["version"], "1.0.0", "lastcall event version");
            event(e["event"].as_str().expect("event name"), e["data"].clone())
        })
        .collect()
}

/// NEAR transfers and `pick_hero` promises among the receipts of the current context.
fn receipts_of_call() -> Receipts {
    let mut out = Receipts::default();
    for r in get_created_receipts() {
        for action in &r.actions {
            match action {
                MockAction::Transfer { deposit, .. } => {
                    out.transfers
                        .push((r.receiver_id.clone(), Some(deposit.as_yoctonear())));
                }
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } => {
                    assert_eq!(r.receiver_id, contract_id(), "promise to the contract only");
                    assert_eq!(
                        method_name.as_slice(),
                        b"pick_hero",
                        "only pick_hero promises"
                    );
                    let args: serde_json::Value =
                        serde_json::from_slice(args).expect("pick_hero args");
                    let day = args["day"].as_u64().expect("day") as u32;
                    out.pick_hero.push(day);
                }
                _ => {}
            }
        }
    }
    out
}

impl PartialEq for Receipts {
    fn eq(&self, other: &Self) -> bool {
        self.pick_hero == other.pick_hero
            && self.transfers.len() == other.transfers.len()
            && self
                .transfers
                .iter()
                .zip(&other.transfers)
                .all(|((a, x), (b, y))| a == b && (x.is_none() || y.is_none() || x == y))
    }
}
