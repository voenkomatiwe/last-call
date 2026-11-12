// Last Call ($LAST): NEAR smart contract. Spec: docs/plans/contract-spec.md.
//
// One account is both the NEP-141 token and the game. This file holds the state (S4) and every
// exported method (S13, S14, NEP-141/145/148) as a thin wrapper over `crate::<module>::<function>`.
// Module ownership: docs/plans/contract-plan.md, section 2. Frozen after C1 review.

pub mod bits;
pub mod checkin;
pub mod config;
pub mod day;
pub mod errors;
pub mod events;
pub mod ft;
pub mod hero;
pub mod init;
pub mod math;
pub mod member;
pub mod nep413;
pub mod types;
pub mod views;

#[cfg(test)]
pub mod test_utils;
#[cfg(test)]
mod tests;

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::{IterableMap, LazyOption, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, PublicKey, near,
};

use crate::config::Config;
use crate::types::{
    CheckInResult, ConfigView, DayReward, DaySummary, KickablePage, Member, MemberView, OpenDay,
    OpenDayView, PendingHero, StateView,
};

/// Storage prefixes of the collections (S4).
#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Token,
    Metadata,
    Maturing,
    Rewards,
    FailedBits,
    History,
    Members,
    FaucetUsed,
}

/// Contract state (S4).
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    config: Config,
    pot_bps: u16,
    faucet_bps: u16,
    initial_supply: u128,
    launch_ns: u64,

    // Buckets on the contract's own FT balance (I1).
    pot: u128,
    reserved: u128,
    stake_pool: u128,
    faucet_left: u128,
    jackpot_pending: u128,

    // Game.
    last_settled: Option<u32>,
    streak: u32,
    longest_streak: u32,
    active_count: u32,
    active_stake: u128,
    members_total: u32,
    open: OpenDay,
    /// Usually 0–1 records.
    pending_heroes: Vec<PendingHero>,
    /// Activation day → how many members become active that day.
    maturing: LookupMap<u32, u32>,
    /// Successful days with unpaid shares.
    rewards: LookupMap<u32, DayReward>,
    /// Word `d / 64`, bit `d % 64`.
    failed_bits: LookupMap<u32, u64>,
    /// Slot `d % HISTORY_LEN`.
    history: LookupMap<u32, DaySummary>,
    /// `remove` is O(1) (swap_remove).
    members: IterableMap<AccountId, Member>,
    faucet_used: LookupSet<AccountId>,

    total_burned: u128,
    total_rewarded: u128,
    total_jackpots: u128,
}

#[near]
impl Contract {
    /// S3.
    #[init]
    pub fn new(
        config: Config,
        total_supply: U128,
        pot_bps: u16,
        faucet_bps: u16,
        initial_holder: AccountId,
        metadata: FungibleTokenMetadata,
    ) -> Self {
        crate::init::new(
            config,
            total_supply,
            pot_bps,
            faucet_bps,
            initial_holder,
            metadata,
        )
    }

    // ---- Game: changing methods (S13) ----

    /// Deposit ≥ `member_storage_deposit` yoctoNEAR; the surplus is refunded.
    #[payable]
    pub fn join(&mut self, checkin_key: Option<PublicKey>) {
        crate::member::join(self, checkin_key)
    }

    pub fn check_in(&mut self) -> CheckInResult {
        crate::checkin::check_in(self)
    }

    pub fn check_in_signed(
        &mut self,
        account_id: AccountId,
        day: u32,
        nonce: Base64VecU8,
        signature: Base64VecU8,
    ) -> CheckInResult {
        crate::checkin::check_in_signed(self, account_id, day, nonce, signature)
    }

    /// Exactly 1 yoctoNEAR.
    #[payable]
    pub fn set_checkin_key(&mut self, key: Option<PublicKey>) {
        crate::member::set_checkin_key(self, key)
    }

    /// Exactly 1 yoctoNEAR.
    #[payable]
    pub fn claim(&mut self) -> U128 {
        crate::member::claim(self)
    }

    /// Exactly 1 yoctoNEAR.
    #[payable]
    pub fn leave(&mut self) -> U128 {
        crate::member::leave(self)
    }

    pub fn kick(&mut self, account_id: AccountId) -> U128 {
        crate::member::kick(self, account_id)
    }

    pub fn settle(&mut self, max_days: Option<u32>) -> u32 {
        crate::day::settle(self, max_days)
    }

    /// Only from the contract's own promise (S11).
    #[private]
    pub fn pick_hero(&mut self, day: u32) {
        crate::hero::pick_hero(self, day)
    }

    pub fn retry_pick_hero(&mut self, day: u32) {
        crate::hero::retry_pick_hero(self, day)
    }

    pub fn faucet(&mut self) -> U128 {
        crate::ft::faucet(self)
    }

    // ---- Views (S14) ----

    pub fn get_config(&self) -> ConfigView {
        crate::views::get_config(self)
    }

    pub fn get_state(&self) -> StateView {
        crate::views::get_state(self)
    }

    pub fn get_open_day(&self) -> OpenDayView {
        crate::views::get_open_day(self)
    }

    pub fn get_history(&self, limit: u32) -> Vec<DaySummary> {
        crate::views::get_history(self, limit)
    }

    pub fn get_member(&self, account_id: AccountId) -> Option<MemberView> {
        crate::views::get_member(self, account_id)
    }

    pub fn get_kickable(&self, from_index: u32, limit: u32) -> KickablePage {
        crate::views::get_kickable(self, from_index, limit)
    }
}

// ---- NEP-141 ----

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        crate::ft::ft_transfer(self, receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        crate::ft::ft_transfer_call(self, receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        crate::ft::ft_total_supply(self)
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        crate::ft::ft_balance_of(self, account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        crate::ft::ft_resolve_transfer(self, sender_id, receiver_id, amount)
    }
}

// ---- NEP-145 ----

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        crate::ft::storage_deposit(self, account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        crate::ft::storage_withdraw(self, amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        crate::ft::storage_unregister(self, force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        crate::ft::storage_balance_bounds(self)
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        crate::ft::storage_balance_of(self, account_id)
    }
}

// ---- NEP-148 ----

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        crate::ft::ft_metadata(self)
    }
}
