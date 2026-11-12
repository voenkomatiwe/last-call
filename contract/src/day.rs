//! Day engine: time, auto-settle, settle, opening and settling days (spec S5, S6, S8). Owner: C5.

use crate::Contract;

/// `((block_timestamp − launch_ns) / (day_length_s × 10^9)) as u32` (S5).
pub fn today(_c: &Contract) -> u32 {
    todo!("C5")
}

/// `last_settled.map_or(0, |d| d + 1)`; always equals `open.day` (S5).
pub fn next(_c: &Contract) -> u32 {
    todo!("C5")
}

/// `today − next` (S5).
pub fn pending(_c: &Contract) -> u32 {
    todo!("C5")
}

/// R6: `ERR_BACKLOG` and `ERR_LOW_GAS` before any work, then `settle_internal(pending)` (S5).
/// Called only by `join`, `check_in`, `check_in_signed`, `claim`, `leave`, `kick`.
pub fn auto_settle(_c: &mut Contract) {
    todo!("C5")
}

/// Public `settle(max_days)` (S5): never `ERR_BACKLOG`; returns the number of settled days.
pub fn settle(_c: &mut Contract, _max_days: Option<u32>) -> u32 {
    todo!("C5")
}

/// Opens day `d` (S6).
pub fn open_day(_c: &mut Contract, _d: u32) {
    todo!("C5")
}
