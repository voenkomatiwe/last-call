//! NEP-141/145/148 bodies, transfer/burn helpers for the game, the faucet (spec S13, S15).
//! Owner: C3.

use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PromiseOrValue};

use crate::Contract;

// ---- NEP-141 ----

/// `receiver_id == current_account_id` → `ERR_USE_JOIN`; otherwise the standard implementation.
pub fn ft_transfer(
    _c: &mut Contract,
    _receiver_id: AccountId,
    _amount: U128,
    _memo: Option<String>,
) {
    todo!("C3")
}

/// `receiver_id == current_account_id` → `ERR_USE_JOIN`; otherwise the standard implementation.
pub fn ft_transfer_call(
    _c: &mut Contract,
    _receiver_id: AccountId,
    _amount: U128,
    _memo: Option<String>,
    _msg: String,
) -> PromiseOrValue<U128> {
    todo!("C3")
}

pub fn ft_total_supply(_c: &Contract) -> U128 {
    todo!("C3")
}

pub fn ft_balance_of(_c: &Contract, _account_id: AccountId) -> U128 {
    todo!("C3")
}

/// Standard resolver, no settle.
pub fn ft_resolve_transfer(
    _c: &mut Contract,
    _sender_id: AccountId,
    _receiver_id: AccountId,
    _amount: U128,
) -> U128 {
    todo!("C3")
}

// ---- NEP-145 ----

pub fn storage_deposit(
    _c: &mut Contract,
    _account_id: Option<AccountId>,
    _registration_only: Option<bool>,
) -> StorageBalance {
    todo!("C3")
}

pub fn storage_withdraw(_c: &mut Contract, _amount: Option<NearToken>) -> StorageBalance {
    todo!("C3")
}

/// A member → `ERR_MEMBER_CANNOT_UNREGISTER`; otherwise the standard implementation.
pub fn storage_unregister(_c: &mut Contract, _force: Option<bool>) -> bool {
    todo!("C3")
}

pub fn storage_balance_bounds(_c: &Contract) -> StorageBalanceBounds {
    todo!("C3")
}

pub fn storage_balance_of(_c: &Contract, _account_id: AccountId) -> Option<StorageBalance> {
    todo!("C3")
}

// ---- NEP-148 ----

pub fn ft_metadata(_c: &Contract) -> FungibleTokenMetadata {
    todo!("C3")
}

// ---- Faucet (S13) ----

pub fn faucet(_c: &mut Contract) -> U128 {
    todo!("C3")
}

// ---- Helpers for the game (C5, C6, C8) ----
//
// They take the token, not the whole contract, so that callers can hold other borrows of the
// contract's fields (e.g. a member record) at the same time. Buckets are the caller's business.

/// contract → `to` via `internal_transfer` (writes `ft_transfer` itself). `amount == 0` → nothing.
/// `to` must be registered (callers check `is_registered` where the spec allows an unregistered
/// receiver).
pub fn transfer_from_contract(
    _token: &mut FungibleToken,
    _to: &AccountId,
    _amount: u128,
    _memo: Option<&str>,
) {
    todo!("C3")
}

/// `from` → contract via `internal_transfer` (writes `ft_transfer` itself). `from` not registered →
/// `ERR_NOT_REGISTERED`; balance < `amount` → `ERR_INSUFFICIENT_BALANCE` (S13 `join`).
pub fn transfer_to_contract(_token: &mut FungibleToken, _from: &AccountId, _amount: u128) {
    todo!("C3")
}

/// `internal_withdraw` from the contract's balance (lowers `total_supply`). Writes no event: the
/// caller emits `FtBurn` (S15).
pub fn burn_from_contract(_token: &mut FungibleToken, _amount: u128) {
    todo!("C3")
}

/// Whether `account_id` is registered in the token (NEP-145).
pub fn is_registered(_token: &FungibleToken, _account_id: &AccountId) -> bool {
    todo!("C3")
}
