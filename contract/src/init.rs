//! `new` (spec S3). Owner: C3.

use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_sdk::AccountId;
use near_sdk::json_types::U128;

use crate::Contract;
use crate::config::Config;

/// S3: `config::validate(...)`, `metadata.assert_valid()`, mint, buckets, `launch_ns`, day 0 opened
/// by hand (`OpenDay::default()`, goal 0) without depending on `day::open_day`.
pub fn new(
    _config: Config,
    _total_supply: U128,
    _pot_bps: u16,
    _faucet_bps: u16,
    _initial_holder: AccountId,
    _metadata: FungibleTokenMetadata,
) -> Contract {
    todo!("C3")
}
