//! Check-in: `do_check_in`, closers (R5), direct and signed paths (spec S7, S12). Owner: C6.

use near_sdk::AccountId;
use near_sdk::json_types::Base64VecU8;

use crate::Contract;
use crate::types::CheckInResult;

/// S7 for `predecessor`, via "direct".
pub fn check_in(_c: &mut Contract) -> CheckInResult {
    todo!("C6")
}

/// S12: anyone may send it, deposit 0; via "signed".
pub fn check_in_signed(
    _c: &mut Contract,
    _account_id: AccountId,
    _day: u32,
    _nonce: Base64VecU8,
    _signature: Base64VecU8,
) -> CheckInResult {
    todo!("C6")
}
