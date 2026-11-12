//! State records (spec S4), view shapes (S14) and internal result types.
//!
//! Amounts are `u128` in state and `U128` (decimal string) in JSON views and events.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, PublicKey, near};

use crate::config::Config;

/// The open (not yet settled) day (S4, S6, S7).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenDay {
    pub day: u32,
    /// 0 means an idle day (fewer than `min_goal` active members when it opened).
    pub goal: u32,
    /// Snapshot of `active_count` when the day opened (minus members who left during the day).
    pub active: u32,
    /// Snapshot of `active_stake` when the day opened (minus members who left during the day).
    pub active_stake: u128,
    pub count: u32,
    pub checked_stake: u128,
    /// Checked in today and then left (R4).
    pub forfeited: u32,
    /// At most `closers_k` accounts, sliding window (R5).
    pub closers: Vec<AccountId>,
    /// `block_height` of the last closer candidate (R5).
    pub closer_height: u64,
}

/// A member record (S4). `stake` is current as of `resolved_through`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub stake: u128,
    pub join_day: u32,
    /// `join_day + warmup_days`.
    pub activation_day: u32,
    pub last_checkin: Option<u32>,
    /// All days `< resolved_through` are applied; equals `activation_day` at join.
    pub resolved_through: u32,
    pub claimable: u128,
    pub checkins: u32,
    pub personal_streak: u32,
    pub best_personal_streak: u32,
    pub hero_count: u32,
    /// yoctoNEAR, refunded on exit.
    pub storage_deposit: u128,
    /// ed25519 only (S12).
    pub checkin_key: Option<PublicKey>,
}

/// A successful day whose shares are not all paid out yet (S8, S9).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DayReward {
    pub per_share: u128,
    pub refs: u32,
}

/// A jackpot waiting for `pick_hero` (S8, S11, R10).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingHero {
    pub day: u32,
    pub closers: Vec<AccountId>,
    pub jackpot: u128,
}

/// Outcome of a settled day (S8).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Fail,
    Idle,
}

/// One slot of the history ring (`history[d % HISTORY_LEN]`, S4, S8) and an item of `get_history`
/// (S14).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaySummary {
    pub day: u32,
    pub outcome: Outcome,
    pub goal: u32,
    pub count: u32,
    pub streak_after: u32,
    pub per_share: U128,
    /// Written by `pick_hero` (S11); `None` at settle time.
    pub hero: Option<AccountId>,
    pub jackpot: U128,
    pub pot_burned: U128,
    pub stake_slashed: U128,
    pub pot_after: U128,
}

/// Result of `check_in` / `check_in_signed` (S7, S14).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheckInResult {
    pub day: u32,
    /// The check-in number of the day (`open.count` after this check-in).
    pub n: u32,
    pub goal: u32,
    pub in_closers: bool,
}

/// Result of `member::resolve_pure` (S9): what `resolve(a, t)` would write, without writing it.
///
/// `resolve` applies it as: `stake = delta.stake`, `claimable += delta.claimable_add`,
/// decrement `rewards[d].refs` for `delta.reward_day == Some(d)` (remove the record at 0),
/// `resolved_through = delta.resolved_through`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolveDelta {
    /// The member's stake after all slashes of failed days in `[from, t)` (R1 rounding).
    pub stake: u128,
    /// Added to `claimable`: `rewards[p].per_share` of the last check-in day `p`, or 0.
    pub claimable_add: u128,
    /// `Some(p)` when the reward of day `p` is credited (its `refs` must be decremented).
    pub reward_day: Option<u32>,
    /// The new `resolved_through` (= `t`).
    pub resolved_through: u32,
}

/// `get_config` (S14): every `Config` field (flattened) plus the launch parameters and constants.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    #[serde(flatten)]
    pub config: Config,
    pub pot_bps: u16,
    pub faucet_bps: u16,
    pub initial_supply: U128,
    /// Nanoseconds; a decimal string because it exceeds 2^53.
    pub launch_ns: U64,
    pub auto_settle_cap: u32,
    pub max_settle_days: u32,
    pub history_len: u32,
}

/// `get_state` (S14).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateView {
    pub today: u32,
    pub last_settled: Option<u32>,
    pub pending_days: u32,
    pub pot: U128,
    pub reserved: U128,
    pub stake_pool: U128,
    pub faucet_left: U128,
    pub jackpot_pending: U128,
    pub pending_hero_days: Vec<u32>,
    pub streak: u32,
    pub longest_streak: u32,
    pub active_count: u32,
    pub active_stake: U128,
    pub members_total: u32,
    pub total_supply: U128,
    pub total_burned: U128,
    pub total_rewarded: U128,
    pub total_jackpots: U128,
    pub ms_to_day_end: u64,
}

/// `get_open_day` (S14).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenDayView {
    pub day: u32,
    pub goal: u32,
    pub count: u32,
    pub active: u32,
    pub forfeited: u32,
    pub closers: Vec<AccountId>,
    /// `goal == 0`.
    pub is_idle: bool,
    /// `day < today` (the day is waiting to be settled).
    pub stale: bool,
}

/// `get_member` (S14): the `Member` fields plus derived values.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberView {
    pub stake: U128,
    pub join_day: u32,
    pub activation_day: u32,
    pub last_checkin: Option<u32>,
    pub resolved_through: u32,
    pub claimable: U128,
    pub checkins: u32,
    pub personal_streak: u32,
    pub best_personal_streak: u32,
    pub hero_count: u32,
    pub storage_deposit: U128,
    /// The page compares it with its local key; a public key is not a secret.
    pub checkin_key: Option<PublicKey>,
    /// Stake after slashes of all settled days (`resolve_pure` with `t = next`).
    pub effective_stake: U128,
    /// `claimable` plus the not yet credited share of settled days
    /// (`resolve_pure` with `t = next`).
    pub pending_claimable: U128,
    pub is_active: bool,
    pub can_check_in_today: bool,
    pub checked_in_today: bool,
    /// `None` during warmup.
    pub kickable_from_day: Option<u32>,
    /// 0 if `last_checkin < today − 1`.
    pub current_personal_streak: u32,
}

/// `get_kickable` (S14). `next_index` is an index in `members`; a page may be empty while
/// `next_index` is `Some`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KickablePage {
    pub accounts: Vec<AccountId>,
    pub next_index: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{alice, params};
    use near_sdk::borsh;
    use near_sdk::serde_json::{self, json};

    /// `get_config` is one flat object (the `Config` fields are not nested), `launch_ns` is a string.
    #[test]
    fn config_view_json_is_flat() {
        let view = ConfigView {
            config: params("demo").config,
            pot_bps: 5000,
            faucet_bps: 100,
            initial_supply: U128(1_000),
            launch_ns: U64(1_800_000_000_000_000_000),
            auto_settle_cap: 50,
            max_settle_days: 500,
            history_len: 64,
        };
        let value = serde_json::to_value(&view).unwrap();
        assert_eq!(
            value,
            json!({
                "day_length_s": 60,
                "warmup_days": 1,
                "goal_bps": 6000,
                "min_goal": 3,
                "closers_k": 5,
                "jackpot_mult": 10,
                "emit_bps": 100,
                "streak_step_bps": 1000,
                "streak_cap": 10,
                "burn_bps": 500,
                "slash_bps": 1000,
                "join_stake": "1000000000000000000000",
                "member_storage_deposit": "10000000000000000000000",
                "faucet_amount": "5000000000000000000000",
                "inactive_days": 3,
                "kick_bounty_bps": 2000,
                "pot_bps": 5000,
                "faucet_bps": 100,
                "initial_supply": "1000",
                "launch_ns": "1800000000000000000",
                "auto_settle_cap": 50,
                "max_settle_days": 500,
                "history_len": 64
            })
        );
        let back: ConfigView = serde_json::from_value(value).unwrap();
        assert_eq!(back, view);
    }

    #[test]
    fn day_summary_json_shape() {
        let summary = DaySummary {
            day: 9,
            outcome: Outcome::Idle,
            goal: 0,
            count: 2,
            streak_after: 4,
            per_share: U128(0),
            hero: Some(alice()),
            jackpot: U128(0),
            pot_burned: U128(0),
            stake_slashed: U128(0),
            pot_after: U128(123),
        };
        assert_eq!(
            serde_json::to_string(&summary).unwrap(),
            concat!(
                r#"{"day":9,"outcome":"Idle","goal":0,"count":2,"streak_after":4,"per_share":"0","#,
                r#""hero":"alice.near","jackpot":"0","pot_burned":"0","stake_slashed":"0","pot_after":"123"}"#
            )
        );
        let bytes = borsh::to_vec(&summary).unwrap();
        assert_eq!(borsh::from_slice::<DaySummary>(&bytes).unwrap(), summary);
    }

    #[test]
    fn check_in_result_and_kickable_page_json_shape() {
        let r = CheckInResult {
            day: 3,
            n: 4,
            goal: 5,
            in_closers: false,
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"day":3,"n":4,"goal":5,"in_closers":false}"#
        );
        let page = KickablePage {
            accounts: vec![alice()],
            next_index: None,
        };
        assert_eq!(
            serde_json::to_string(&page).unwrap(),
            r#"{"accounts":["alice.near"],"next_index":null}"#
        );
    }

    #[test]
    fn member_borsh_roundtrip_with_key() {
        let key: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap();
        let m = Member {
            stake: 100,
            join_day: 1,
            activation_day: 3,
            last_checkin: Some(5),
            resolved_through: 5,
            claimable: 7,
            checkins: 2,
            personal_streak: 1,
            best_personal_streak: 2,
            hero_count: 0,
            storage_deposit: 10,
            checkin_key: Some(key),
        };
        let bytes = borsh::to_vec(&m).unwrap();
        assert_eq!(borsh::from_slice::<Member>(&bytes).unwrap(), m);
    }
}
