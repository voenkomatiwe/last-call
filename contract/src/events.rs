//! Game events (spec S15) in NEP-297 format:
//! `EVENT_JSON:{"standard":"lastcall","version":"1.0.0","event":<name>,"data":<object>}`.
//!
//! FT events (`ft_mint`, `ft_transfer`, `ft_burn`) come from
//! `near_contract_standards::fungible_token::events`; they are not duplicated here.
//! Amounts are `U128` decimal strings in JSON.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{AccountId, env, near, serde_json};

use crate::types::{CheckInResult, Outcome};

pub const EVENT_STANDARD: &str = "lastcall";
pub const EVENT_VERSION: &str = "1.0.0";

/// How a check-in arrived (`check_in.via`).
#[near(serializers = [json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckInVia {
    /// `check_in()` by the member.
    Direct,
    /// `check_in_signed(...)` (NEP-413), sent by anyone.
    Signed,
}

/// One record of `days_settled.runs`: a single day, or consecutive empty days (`count == 0`) with
/// the same `outcome` and `goal` merged into one record with summed amounts (S15).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettledRun {
    pub from_day: u32,
    pub to_day: u32,
    pub outcome: Outcome,
    pub goal: u32,
    pub count: u32,
    pub streak_after: u32,
    pub per_share: U128,
    pub jackpot: U128,
    pub pot_burned: U128,
    pub stake_slashed: U128,
    pub pot_after: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: &'a T,
}

fn emit<T: Serialize>(event: &str, data: &T) {
    let envelope = Envelope {
        standard: EVENT_STANDARD,
        version: EVENT_VERSION,
        event,
        data,
    };
    // Serializing these plain structs cannot fail.
    let json = serde_json::to_string(&envelope).unwrap_or_else(|_| env::abort());
    env::log_str(&format!("EVENT_JSON:{json}"));
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct JoinData<'a> {
    account_id: &'a AccountId,
    stake: U128,
    activation_day: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct CheckInData<'a> {
    account_id: &'a AccountId,
    day: u32,
    n: u32,
    goal: u32,
    in_closers: bool,
    via: CheckInVia,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct DaysSettledData<'a> {
    runs: &'a [SettledRun],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct HeroData<'a> {
    day: u32,
    account_id: &'a AccountId,
    jackpot: U128,
    paid: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AmountData<'a> {
    account_id: &'a AccountId,
    amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LeaveData<'a> {
    account_id: &'a AccountId,
    returned: U128,
    fee_burned: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct KickData<'a> {
    account_id: &'a AccountId,
    by: &'a AccountId,
    returned: U128,
    fee_burned: U128,
    bounty: U128,
}

/// `join { account_id, stake, activation_day }`.
pub fn emit_join(account_id: &AccountId, stake: u128, activation_day: u32) {
    emit(
        "join",
        &JoinData {
            account_id,
            stake: U128(stake),
            activation_day,
        },
    );
}

/// `check_in { account_id, day, n, goal, in_closers, via }`.
pub fn emit_check_in(account_id: &AccountId, result: &CheckInResult, via: CheckInVia) {
    emit(
        "check_in",
        &CheckInData {
            account_id,
            day: result.day,
            n: result.n,
            goal: result.goal,
            in_closers: result.in_closers,
            via,
        },
    );
}

/// `days_settled { runs }` — one log per settle call (S15).
pub fn emit_days_settled(runs: &[SettledRun]) {
    emit("days_settled", &DaysSettledData { runs });
}

/// `hero { day, account_id, jackpot, paid }`.
pub fn emit_hero(day: u32, account_id: &AccountId, jackpot: u128, paid: bool) {
    emit(
        "hero",
        &HeroData {
            day,
            account_id,
            jackpot: U128(jackpot),
            paid,
        },
    );
}

/// `claim { account_id, amount }`.
pub fn emit_claim(account_id: &AccountId, amount: u128) {
    emit(
        "claim",
        &AmountData {
            account_id,
            amount: U128(amount),
        },
    );
}

/// `leave { account_id, returned, fee_burned }`. `returned = stake − fee` without `claimable` (equals
/// the return value of `leave()`); the paid-out `claimable` shows in the `ft_transfer` log.
pub fn emit_leave(account_id: &AccountId, returned: u128, fee_burned: u128) {
    emit(
        "leave",
        &LeaveData {
            account_id,
            returned: U128(returned),
            fee_burned: U128(fee_burned),
        },
    );
}

/// `kick { account_id, by, returned, fee_burned, bounty }`. `returned = stake − fee` without
/// `claimable` (as in `leave`); the paid-out `claimable` shows in the `ft_transfer` log.
pub fn emit_kick(
    account_id: &AccountId,
    by: &AccountId,
    returned: u128,
    fee_burned: u128,
    bounty: u128,
) {
    emit(
        "kick",
        &KickData {
            account_id,
            by,
            returned: U128(returned),
            fee_burned: U128(fee_burned),
            bounty: U128(bounty),
        },
    );
}

/// `faucet { account_id, amount }`.
pub fn emit_faucet(account_id: &AccountId, amount: u128) {
    emit(
        "faucet",
        &AmountData {
            account_id,
            amount: U128(amount),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{alice, bob, context};
    use near_sdk::NearToken;
    use near_sdk::test_utils::get_logs;

    const HEAD: &str = r#"EVENT_JSON:{"standard":"lastcall","version":"1.0.0","event":"#;

    fn single_log() -> String {
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        logs[0].clone()
    }

    #[test]
    fn join_event_format() {
        context(&alice(), NearToken::from_yoctonear(0));
        emit_join(&alice(), 100_000_000_000_000_000_000_000, 2);
        assert_eq!(
            single_log(),
            format!(
                r#"{HEAD}"join","data":{{"account_id":"alice.near","stake":"100000000000000000000000","activation_day":2}}}}"#
            )
        );
    }

    #[test]
    fn check_in_event_format() {
        context(&alice(), NearToken::from_yoctonear(0));
        let r = CheckInResult {
            day: 7,
            n: 3,
            goal: 5,
            in_closers: true,
        };
        emit_check_in(&alice(), &r, CheckInVia::Direct);
        emit_check_in(&bob(), &r, CheckInVia::Signed);
        let logs = get_logs();
        assert_eq!(
            logs,
            vec![
                format!(
                    r#"{HEAD}"check_in","data":{{"account_id":"alice.near","day":7,"n":3,"goal":5,"in_closers":true,"via":"direct"}}}}"#
                ),
                format!(
                    r#"{HEAD}"check_in","data":{{"account_id":"bob.near","day":7,"n":3,"goal":5,"in_closers":true,"via":"signed"}}}}"#
                ),
            ]
        );
    }

    #[test]
    fn days_settled_event_format() {
        context(&alice(), NearToken::from_yoctonear(0));
        let runs = [
            SettledRun {
                from_day: 3,
                to_day: 3,
                outcome: Outcome::Success,
                goal: 5,
                count: 6,
                streak_after: 1,
                per_share: U128(11),
                jackpot: U128(110),
                pot_burned: U128(0),
                stake_slashed: U128(0),
                pot_after: U128(999),
            },
            SettledRun {
                from_day: 4,
                to_day: 6,
                outcome: Outcome::Fail,
                goal: 5,
                count: 0,
                streak_after: 0,
                per_share: U128(0),
                jackpot: U128(0),
                pot_burned: U128(142),
                stake_slashed: U128(271),
                pot_after: U128(857),
            },
        ];
        emit_days_settled(&runs);
        assert_eq!(
            single_log(),
            format!(
                concat!(
                    r#"{HEAD}"days_settled","data":{{"runs":["#,
                    r#"{{"from_day":3,"to_day":3,"outcome":"Success","goal":5,"count":6,"streak_after":1,"#,
                    r#""per_share":"11","jackpot":"110","pot_burned":"0","stake_slashed":"0","pot_after":"999"}},"#,
                    r#"{{"from_day":4,"to_day":6,"outcome":"Fail","goal":5,"count":0,"streak_after":0,"#,
                    r#""per_share":"0","jackpot":"0","pot_burned":"142","stake_slashed":"271","pot_after":"857"}}"#,
                    r#"]}}}}"#
                ),
                HEAD = HEAD
            )
        );
    }

    #[test]
    fn hero_event_format() {
        context(&alice(), NearToken::from_yoctonear(0));
        emit_hero(12, &bob(), 5_000, false);
        assert_eq!(
            single_log(),
            format!(
                r#"{HEAD}"hero","data":{{"day":12,"account_id":"bob.near","jackpot":"5000","paid":false}}}}"#
            )
        );
    }

    #[test]
    fn claim_leave_kick_faucet_event_format() {
        context(&alice(), NearToken::from_yoctonear(0));
        emit_claim(&alice(), 42);
        emit_leave(&alice(), 900, 100);
        emit_kick(&alice(), &bob(), 900, 80, 20);
        emit_faucet(&bob(), 5_000_000_000_000_000_000_000);
        assert_eq!(
            get_logs(),
            vec![
                format!(r#"{HEAD}"claim","data":{{"account_id":"alice.near","amount":"42"}}}}"#),
                format!(
                    r#"{HEAD}"leave","data":{{"account_id":"alice.near","returned":"900","fee_burned":"100"}}}}"#
                ),
                format!(
                    r#"{HEAD}"kick","data":{{"account_id":"alice.near","by":"bob.near","returned":"900","fee_burned":"80","bounty":"20"}}}}"#
                ),
                format!(
                    r#"{HEAD}"faucet","data":{{"account_id":"bob.near","amount":"5000000000000000000000"}}}}"#
                ),
            ]
        );
    }
}
