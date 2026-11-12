//! View methods (spec S14). Owner: C7.

use near_sdk::AccountId;

use crate::Contract;
use crate::types::{ConfigView, DaySummary, KickablePage, MemberView, OpenDayView, StateView};

pub fn get_config(_c: &Contract) -> ConfigView {
    todo!("C7")
}

pub fn get_state(_c: &Contract) -> StateView {
    todo!("C7")
}

pub fn get_open_day(_c: &Contract) -> OpenDayView {
    todo!("C7")
}

/// From `last_settled` backwards, at most `min(limit, HISTORY_LEN)`, newest first; slots holding
/// another day are skipped.
pub fn get_history(_c: &Contract, _limit: u32) -> Vec<DaySummary> {
    todo!("C7")
}

/// `resolve_pure` with `t = next` (settled days only), no writes.
pub fn get_member(_c: &Contract, _account_id: AccountId) -> Option<MemberView> {
    todo!("C7")
}

/// Filter within the index window `[from_index, from_index + limit)` of `members`.
pub fn get_kickable(_c: &Contract, _from_index: u32, _limit: u32) -> KickablePage {
    todo!("C7")
}
