//! Members: join, resolve, claim, exit (leave/kick), check-in key (spec S9, S10, S13). Owner: C6.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, PublicKey};

use crate::Contract;
use crate::types::{Member, ResolveDelta};

/// S13 `join`.
pub fn join(_c: &mut Contract, _checkin_key: Option<PublicKey>) {
    todo!("C6")
}

/// S13 `set_checkin_key`: exactly 1 yocto (`ERR_ONE_YOCTO`), no auto-settle.
pub fn set_checkin_key(_c: &mut Contract, _key: Option<PublicKey>) {
    todo!("C6")
}

/// S13 `claim`: exactly 1 yocto; returns the claimed amount.
pub fn claim(_c: &mut Contract) -> U128 {
    todo!("C6")
}

/// S10 with kind Leave: exactly 1 yocto; returns `stake − fee` (S13).
pub fn leave(_c: &mut Contract) -> U128 {
    todo!("C6")
}

/// S10 with kind Kick; returns the bounty (S13).
pub fn kick(_c: &mut Contract, _account_id: AccountId) -> U128 {
    todo!("C6")
}

/// S9 without writing: what `resolve(m, t)` would apply (all days `< t` must be settled).
/// Used by `resolve` (C6) and by `get_member` with `t = next` (C7).
pub fn resolve_pure(_c: &Contract, _m: &Member, _t: u32) -> ResolveDelta {
    todo!("C6")
}
