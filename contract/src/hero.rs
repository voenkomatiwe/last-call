//! Hero draw in a separate receipt (spec S11, R10). Owner: C8.

use crate::Contract;

/// `#[private]` in `lib.rs`. No auto-settle, no external calls, no branch that can panic.
pub fn pick_hero(_c: &mut Contract, _day: u32) {
    todo!("C8")
}

/// Anyone: `ERR_NO_PENDING_HERO`, `require_pick_hero_gas()`, then `schedule_pick_hero(day)`.
pub fn retry_pick_hero(_c: &mut Contract, _day: u32) {
    todo!("C8")
}

/// `prepaid_gas − used_gas ≥ PICK_HERO_GAS + GAS_RESERVE`, else `ERR_LOW_GAS` (S5, S11).
/// The only gas check for the hero promise: C5 (`settle`, `auto_settle`) and C8 (`retry_pick_hero`)
/// call this function.
pub fn require_pick_hero_gas() {
    todo!("C8")
}

/// Promise to `current_account_id`: `pick_hero(day)`, static gas `PICK_HERO_GAS`, deposit 0, the
/// result is not awaited (S8, S11). The only place that creates it: C5 (`settle_open_day` via
/// `settle` / `auto_settle`) and C8 (`retry_pick_hero`) call this function.
pub fn schedule_pick_hero(_day: u32) {
    todo!("C8")
}
