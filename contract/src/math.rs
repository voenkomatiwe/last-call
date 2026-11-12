//! Pure formulas, no storage (spec S6, S8, S9, S11). Owner: C2.
//! Signatures follow the C2 brief (docs/plans/contract-plan.md); C2 may refine them.

/// S6: `0` if `active_count < min_goal`,
/// else `max(min_goal, ceil(active_count × goal_bps / B))` in u64.
pub fn goal_for(_active_count: u32, _min_goal: u32, _goal_bps: u16) -> u32 {
    todo!("C2")
}

/// `B + min(streak, cap) × step_bps` (S8).
pub fn mult_bps(_streak: u32, _cap: u32, _step_bps: u16) -> u128 {
    todo!("C2")
}

/// `pot × emit_bps × mult_bps / 10^8` (S8).
pub fn budget(_pot: u128, _emit_bps: u16, _mult_bps: u128) -> u128 {
    todo!("C2")
}

/// `budget / (count + jackpot_mult)` (S8).
pub fn per_share(_budget: u128, _count: u32, _jackpot_mult: u32) -> u128 {
    todo!("C2")
}

/// `(active_stake − checked_stake) × slash_bps / B`, floor (S8).
/// The `min(…, active_stake)` of R11 is the caller's.
pub fn aggregate_slash(_active_stake: u128, _checked_stake: u128, _slash_bps: u16) -> u128 {
    todo!("C2")
}

/// `n` times `stake × (B − b) / B`, early exit at 0 (S9, R1).
pub fn stake_after_slashes(_stake: u128, _n: u32, _slash_bps: u16) -> u128 {
    todo!("C2")
}

/// `stake × b / B` (S10).
pub fn leave_fee(_stake: u128, _slash_bps: u16) -> u128 {
    todo!("C2")
}

/// `u64::from_le_bytes(sha256(seed ‖ day.to_le_bytes() ‖ b"lastcall")[0..8]) % len` (S11).
pub fn hero_index(_seed: &[u8; 32], _day: u32, _len: usize) -> usize {
    todo!("C2")
}
