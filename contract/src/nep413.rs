//! NEP-413 payload and signature check for `check_in_signed` (spec S12). Owner: C4.
//! Signatures follow the C4 brief (docs/plans/contract-plan.md); C4 may refine them.

use near_sdk::{AccountId, PublicKey};

/// Borsh payload of S12: tag `2^31 + 413`, message
/// `{"action":"check_in","account_id":"<acct>","day":<day>}`, `[u8; 32]` nonce without a length
/// prefix, recipient, `callback_url = None`.
pub fn payload_bytes(
    _account_id: &AccountId,
    _day: u32,
    _nonce: &[u8; 32],
    _recipient: &AccountId,
) -> Vec<u8> {
    todo!("C4")
}

/// `nonce.len() == 32 && signature.len() == 64`, ed25519 key only,
/// `ed25519_verify(sig, sha256(payload), pk)`.
pub fn verify(
    _account_id: &AccountId,
    _day: u32,
    _nonce: &[u8],
    _signature: &[u8],
    _recipient: &AccountId,
    _key: &PublicKey,
) -> bool {
    todo!("C4")
}
