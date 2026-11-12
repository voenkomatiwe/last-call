//! `new` (spec S3). Owner: C3.

use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LazyOption, LookupMap, LookupSet};
use near_sdk::{AccountId, env};

use crate::config::{self, BPS_BASE, Config};
use crate::types::OpenDay;
use crate::{Contract, StorageKey};

/// Memo of the launch `ft_mint` event (S3).
const LAUNCH_MEMO: &str = "launch";

/// S3: `config::validate(...)`, `metadata.assert_valid()`, mint, buckets, `launch_ns`, day 0 opened
/// by hand (`OpenDay::default()`, goal 0) without depending on `day::open_day`.
pub fn new(
    config: Config,
    total_supply: U128,
    pot_bps: u16,
    faucet_bps: u16,
    initial_holder: AccountId,
    metadata: FungibleTokenMetadata,
) -> Contract {
    let total_supply = total_supply.0;
    config::validate(&config, total_supply, pot_bps, faucet_bps, &initial_holder);
    // Standard near-contract-standards messages, not ERR_BAD_CONFIG (S3, decision of 12.11).
    metadata.assert_valid();

    // No overflow: total_supply ≤ u128::MAX / 10^8 and bps ≤ 10^4 (validated above).
    let pot = total_supply * u128::from(pot_bps) / BPS_BASE;
    let faucet_left = total_supply * u128::from(faucet_bps) / BPS_BASE;
    let holder_amt = total_supply - pot - faucet_left;
    let contract_amt = pot + faucet_left;

    let contract_id = env::current_account_id();
    let mut token = FungibleToken::new(StorageKey::Token);
    token.internal_register_account(&contract_id);
    token.internal_register_account(&initial_holder);

    // `internal_deposit` raises the token's `total_supply`; there are no other mints (S3).
    let mut mints = Vec::with_capacity(2);
    if contract_amt > 0 {
        token.internal_deposit(&contract_id, contract_amt);
        mints.push(FtMint {
            owner_id: &contract_id,
            amount: U128(contract_amt),
            memo: Some(LAUNCH_MEMO),
        });
    }
    if holder_amt > 0 {
        token.internal_deposit(&initial_holder, holder_amt);
        mints.push(FtMint {
            owner_id: &initial_holder,
            amount: U128(holder_amt),
            memo: Some(LAUNCH_MEMO),
        });
    }
    // total_supply > 0 (validated), so `mints` is not empty: exactly one log.
    FtMint::emit_many(&mints);

    Contract {
        token,
        metadata: LazyOption::new(StorageKey::Metadata, Some(metadata)),
        config,
        pot_bps,
        faucet_bps,
        initial_supply: total_supply,
        launch_ns: env::block_timestamp(),

        pot,
        reserved: 0,
        stake_pool: 0,
        faucet_left,
        jackpot_pending: 0,

        last_settled: None,
        streak: 0,
        longest_streak: 0,
        active_count: 0,
        active_stake: 0,
        members_total: 0,
        // No active members → idle day 0 (S3, S6).
        open: OpenDay {
            day: 0,
            goal: 0,
            ..OpenDay::default()
        },
        pending_heroes: Vec::new(),
        maturing: LookupMap::new(StorageKey::Maturing),
        rewards: LookupMap::new(StorageKey::Rewards),
        failed_bits: LookupMap::new(StorageKey::FailedBits),
        history: LookupMap::new(StorageKey::History),
        members: IterableMap::new(StorageKey::Members),
        faucet_used: LookupSet::new(StorageKey::FaucetUsed),

        total_burned: 0,
        total_rewarded: 0,
        total_jackpots: 0,
    }
}

#[cfg(test)]
mod tests {
    use near_contract_standards::fungible_token::FungibleTokenCore;
    use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;
    use near_sdk::json_types::Base64VecU8;
    use near_sdk::serde_json::{Value, json};
    use near_sdk::test_utils::get_logs;

    use super::*;
    use crate::ft::is_registered;
    use crate::test_utils::{
        LAUNCH_NS, NO_DEPOSIT, ParamSet, context, contract_id, event_logs, metadata, owner, params,
        set_time, setup,
    };

    /// 10^27: `total_supply` of every set in params.json.
    const TOTAL: u128 = 1_000_000_000_000_000_000_000_000_000;
    /// 5·10^26: 50% of 10^27.
    const HALF: u128 = 500_000_000_000_000_000_000_000_000;

    /// `new` with arbitrary parameters at day 0, `owner()` as the caller.
    fn deploy(p: ParamSet, holder: AccountId) -> Contract {
        set_time(0, 0);
        context(&owner(), NO_DEPOSIT);
        Contract::new(
            p.config,
            p.total_supply,
            p.pot_bps,
            p.faucet_bps,
            holder,
            metadata(),
        )
    }

    fn mint_event(data: Value) -> Value {
        json!({ "standard": "nep141", "version": "1.0.0", "event": "ft_mint", "data": data })
    }

    fn balance(c: &Contract, account_id: AccountId) -> u128 {
        c.ft_balance_of(account_id).0
    }

    #[test]
    fn t01_new_mainnet_mints_exactly_total_supply() {
        let c = setup("mainnet");
        // Exactly one log, and it is the ft_mint (read before any setter resets the logs).
        assert_eq!(get_logs().len(), 1);
        assert_eq!(
            event_logs(),
            vec![mint_event(json!([
                { "owner_id": "lastcall.near", "amount": "500000000000000000000000000", "memo": "launch" },
                { "owner_id": "owner.near", "amount": "500000000000000000000000000", "memo": "launch" },
            ]))]
        );

        assert_eq!(c.ft_total_supply(), U128(TOTAL));
        assert_eq!(balance(&c, contract_id()), HALF);
        assert_eq!(balance(&c, owner()), HALF);
        // pot = 10^27 × 5000 / 10^4 = 5·10^26; faucet_bps = 0 → faucet_left = 0.
        assert_eq!(c.pot, HALF);
        assert_eq!(c.faucet_left, 0);
        assert_eq!((c.reserved, c.stake_pool, c.jackpot_pending), (0, 0, 0));
        assert_eq!(c.initial_supply, TOTAL);
        assert_eq!(c.launch_ns, LAUNCH_NS);
        assert_eq!((c.pot_bps, c.faucet_bps), (5000, 0));
        assert_eq!(c.config, params("mainnet").config);
        assert_eq!(
            (c.total_burned, c.total_rewarded, c.total_jackpots),
            (0, 0, 0)
        );
    }

    #[test]
    fn t01_new_demo_buckets() {
        let c = setup("demo");
        // pot = 10^27 × 5000 / 10^4 = 5·10^26; faucet_left = 10^27 × 100 / 10^4 = 10^25;
        // holder = 10^27 − 5·10^26 − 10^25 = 4.9·10^26; contract = 5·10^26 + 10^25 = 5.1·10^26.
        assert_eq!(get_logs().len(), 1);
        assert_eq!(
            event_logs(),
            vec![mint_event(json!([
                { "owner_id": "lastcall.near", "amount": "510000000000000000000000000", "memo": "launch" },
                { "owner_id": "owner.near", "amount": "490000000000000000000000000", "memo": "launch" },
            ]))]
        );
        assert_eq!(c.pot, HALF);
        assert_eq!(c.faucet_left, 10_000_000_000_000_000_000_000_000);
        assert_eq!(
            balance(&c, contract_id()),
            510_000_000_000_000_000_000_000_000
        );
        assert_eq!(balance(&c, owner()), 490_000_000_000_000_000_000_000_000);
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
        assert_eq!(c.initial_supply, TOTAL);
        assert_eq!((c.pot_bps, c.faucet_bps), (5000, 100));
    }

    #[test]
    fn t01_new_rounds_buckets_down_holder_takes_the_rest() {
        let mut p = params("mainnet");
        p.total_supply = U128(999);
        p.pot_bps = 3333;
        p.faucet_bps = 20;
        let c = deploy(p, owner());
        // pot = floor(999 × 3333 / 10^4) = floor(332.9667) = 332;
        // faucet_left = floor(999 × 20 / 10^4) = floor(1.998) = 1; holder = 999 − 332 − 1 = 666.
        assert_eq!(
            event_logs(),
            vec![mint_event(json!([
                { "owner_id": "lastcall.near", "amount": "333", "memo": "launch" },
                { "owner_id": "owner.near", "amount": "666", "memo": "launch" },
            ]))]
        );
        assert_eq!((c.pot, c.faucet_left), (332, 1));
        assert_eq!(balance(&c, contract_id()), 333);
        assert_eq!(balance(&c, owner()), 666);
        assert_eq!(c.ft_total_supply(), U128(999));
        assert_eq!(c.initial_supply, 999);
    }

    #[test]
    fn t01_new_without_pot_mints_only_to_holder() {
        let mut p = params("mainnet");
        p.pot_bps = 0;
        p.faucet_bps = 0;
        let c = deploy(p, owner());
        assert_eq!(get_logs().len(), 1);
        assert_eq!(
            event_logs(),
            vec![mint_event(json!([
                { "owner_id": "owner.near", "amount": "1000000000000000000000000000", "memo": "launch" },
            ]))]
        );
        // The contract is registered anyway (it receives stakes later).
        assert!(is_registered(&c.token, &contract_id()));
        assert_eq!(balance(&c, contract_id()), 0);
        assert_eq!((c.pot, c.faucet_left), (0, 0));
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
    }

    #[test]
    fn t01_new_without_holder_share_mints_only_to_contract() {
        let mut p = params("mainnet");
        p.pot_bps = 5000;
        p.faucet_bps = 5000;
        let c = deploy(p, owner());
        assert_eq!(get_logs().len(), 1);
        assert_eq!(
            event_logs(),
            vec![mint_event(json!([
                { "owner_id": "lastcall.near", "amount": "1000000000000000000000000000", "memo": "launch" },
            ]))]
        );
        assert!(is_registered(&c.token, &owner()));
        assert_eq!(balance(&c, owner()), 0);
        assert_eq!((c.pot, c.faucet_left), (HALF, HALF));
        assert_eq!(c.ft_total_supply(), U128(TOTAL));
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_CONFIG")]
    fn t01_initial_holder_is_contract_rejected() {
        deploy(params("demo"), contract_id());
    }

    /// `metadata.assert_valid()` fails with the standard message, not ERR_BAD_CONFIG (S3, 12.11).
    #[test]
    #[should_panic(expected = "Hash has to be 32 bytes")]
    fn t01_bad_metadata_rejected_with_standard_message() {
        let p = params("demo");
        let mut m = metadata();
        m.reference = Some("https://example.org/last.json".to_string());
        m.reference_hash = Some(Base64VecU8(vec![0; 31]));
        set_time(0, 0);
        context(&owner(), NO_DEPOSIT);
        Contract::new(
            p.config,
            p.total_supply,
            p.pot_bps,
            p.faucet_bps,
            owner(),
            m,
        );
    }

    #[test]
    fn t01_new_opens_idle_day_zero() {
        let c = setup("demo");
        assert_eq!(
            c.open,
            OpenDay {
                day: 0,
                goal: 0,
                active: 0,
                active_stake: 0,
                count: 0,
                checked_stake: 0,
                forfeited: 0,
                closers: vec![],
                closer_height: 0,
            }
        );
        assert_eq!(c.last_settled, None);
        assert_eq!((c.streak, c.longest_streak), (0, 0));
        assert_eq!((c.active_count, c.active_stake, c.members_total), (0, 0, 0));
        assert!(c.pending_heroes.is_empty());
        assert!(c.members.is_empty());
        assert_eq!(c.maturing.get(&0), None);
        assert!(is_registered(&c.token, &contract_id()));
        assert!(is_registered(&c.token, &owner()));
        // FungibleTokenMetadata has no PartialEq: compare the JSON forms.
        assert_eq!(
            near_sdk::serde_json::to_value(c.ft_metadata()).unwrap(),
            near_sdk::serde_json::to_value(metadata()).unwrap()
        );
    }
}
