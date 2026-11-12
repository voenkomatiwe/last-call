//! `failed_bits`: word `d / 64`, bit `d % 64` (spec S4, S8, S9). Owner: C2.
//! Signatures follow the C2 brief (docs/plans/contract-plan.md); C2 may refine them.

use near_sdk::store::LookupMap;

/// Sets the bit of day `d`.
pub fn set(_bits: &mut LookupMap<u32, u64>, _d: u32) {
    todo!("C2")
}

/// Whether the bit of day `d` is set.
pub fn is_set(_bits: &LookupMap<u32, u64>, _d: u32) -> bool {
    todo!("C2")
}

/// Number of set bits in `[from, to)` (0 if `from ≥ to`), word by word with masks.
pub fn count(_bits: &LookupMap<u32, u64>, _from: u32, _to: u32) -> u32 {
    todo!("C2")
}
