//! Check-in: `do_check_in`, closers (R5), direct and signed paths (spec S7, S12). Owner: C6.

use near_sdk::json_types::Base64VecU8;
use near_sdk::{AccountId, env, require};

use crate::day::{auto_settle, today};
use crate::errors::{
    ERR_ALREADY_CHECKED_IN, ERR_BAD_DAY, ERR_BAD_SIGNATURE, ERR_NO_CHECKIN_KEY, ERR_WARMUP,
};
use crate::events::{self, CheckInVia};
use crate::member::{load, resolve};
use crate::types::CheckInResult;
use crate::{Contract, nep413};

/// S7 for `predecessor`, via "direct".
pub fn check_in(c: &mut Contract) -> CheckInResult {
    auto_settle(c);
    let caller = env::predecessor_account_id();
    do_check_in(c, &caller, CheckInVia::Direct)
}

/// S12: anyone may send it, deposit 0; via "signed".
pub fn check_in_signed(
    c: &mut Contract,
    account_id: AccountId,
    day: u32,
    nonce: Base64VecU8,
    signature: Base64VecU8,
) -> CheckInResult {
    auto_settle(c);
    let key = load(c, &account_id)
        .checkin_key
        .unwrap_or_else(|| env::panic_str(ERR_NO_CHECKIN_KEY));
    require!(day == today(c), ERR_BAD_DAY);
    require!(
        nonce.0.len() == 32
            && signature.0.len() == 64
            && nep413::verify(
                &account_id,
                day,
                &nonce.0,
                &signature.0,
                &env::current_account_id(),
                &key,
            ),
        ERR_BAD_SIGNATURE
    );
    do_check_in(c, &account_id, CheckInVia::Signed)
}

/// S7 for `account_id` on `today` after the auto-settle (`today == open.day`).
pub(crate) fn do_check_in(
    c: &mut Contract,
    account_id: &AccountId,
    via: CheckInVia,
) -> CheckInResult {
    let d = today(c);
    record_check_in(c, account_id, d, env::block_height(), via)
}

/// S7 on day `d == open.day` at block height `h`: checks, resolve, personal streak, counters,
/// closers (R5), event.
fn record_check_in(
    c: &mut Contract,
    account_id: &AccountId,
    d: u32,
    h: u64,
    via: CheckInVia,
) -> CheckInResult {
    debug_assert_eq!(d, c.open.day);
    let mut m = load(c, account_id);
    require!(m.activation_day <= d, ERR_WARMUP);
    require!(m.last_checkin != Some(d), ERR_ALREADY_CHECKED_IN);
    resolve(c, &mut m, d);

    let yesterday = d.checked_sub(1);
    m.personal_streak = if yesterday.is_some() && m.last_checkin == yesterday {
        m.personal_streak + 1
    } else {
        1
    };
    m.best_personal_streak = m.best_personal_streak.max(m.personal_streak);
    c.open.count += 1;
    c.open.checked_stake += m.stake;
    m.last_checkin = Some(d);
    m.checkins += 1;
    c.members.insert(account_id.clone(), m);

    // R5: a candidate only within the goal and only the first check-in of a block; the window
    // keeps the last K candidates.
    let open = &mut c.open;
    let in_closers = open.goal > 0 && open.count <= open.goal && h != open.closer_height;
    if in_closers {
        open.closers.push(account_id.clone());
        if open.closers.len() > c.config.closers_k as usize {
            open.closers.remove(0);
        }
        open.closer_height = h;
    }

    let result = CheckInResult {
        day: d,
        n: open.count,
        goal: open.goal,
        in_closers,
    };
    events::emit_check_in(account_id, &result, via);
    result
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::borsh::{self, BorshSerialize};
    use near_sdk::serde_json::{self, Value, json};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{PublicKey, env, testing_env};

    use super::*;
    use crate::errors::{ERR_BAD_KEY, ERR_NOT_MEMBER, ERR_ONE_YOCTO};
    use crate::member::testkit::*;
    use crate::test_utils::{
        NO_DEPOSIT, ONE_YOCTO, alice, bob, carol, context, contract_id, event_logs, set_time,
        setup, user,
    };

    const FIXTURE: &str = include_str!("../tests/fixtures/nep413.json");

    /// NEP-413 `Payload` serialized by the borsh crate (independent of `nep413::payload_bytes`).
    #[derive(BorshSerialize)]
    #[borsh(crate = "near_sdk::borsh")]
    struct Payload {
        message: String,
        nonce: [u8; 32],
        recipient: String,
        callback_url: Option<String>,
    }

    fn key_pair(seed: u8) -> (SigningKey, PublicKey) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let mut bytes = vec![0u8];
        bytes.extend_from_slice(sk.verifying_key().as_bytes());
        (sk, PublicKey::try_from(bytes).expect("ed25519 key"))
    }

    fn sign(
        sk: &SigningKey,
        account: &AccountId,
        day: u32,
        nonce: [u8; 32],
        recipient: &str,
    ) -> Vec<u8> {
        let payload = Payload {
            message: format!(r#"{{"action":"check_in","account_id":"{account}","day":{day}}}"#),
            nonce,
            recipient: recipient.to_string(),
            callback_url: None,
        };
        let bytes = borsh::to_vec(&(2_147_484_061u32, payload)).expect("borsh");
        sk.sign(&env::sha256(&bytes)).to_bytes().to_vec()
    }

    /// `check_in_signed` relayed by `relayer` (anyone).
    fn signed(
        c: &mut Contract,
        relayer: &AccountId,
        account: &AccountId,
        day: u32,
        nonce: &[u8],
        signature: &[u8],
    ) -> CheckInResult {
        context(relayer, NO_DEPOSIT);
        c.check_in_signed(
            account.clone(),
            day,
            Base64VecU8::from(nonce.to_vec()),
            Base64VecU8::from(signature.to_vec()),
        )
    }

    fn set_key(c: &mut Contract, a: &AccountId, key: Option<PublicKey>) {
        context(a, ONE_YOCTO);
        c.set_checkin_key(key);
    }

    fn check_in_events() -> Vec<Value> {
        event_logs()
            .into_iter()
            .filter(|e| e["event"] == "check_in")
            .map(|e| e["data"].clone())
            .collect()
    }

    fn in_closers(results: &[CheckInResult]) -> Vec<bool> {
        results.iter().map(|r| r.in_closers).collect()
    }

    // ---- 3, 4: warmup, one check-in a day ----

    /// mainnet: warmup 2. Joined on day 0 → active from day 2.
    #[test]
    fn t03_warmup_until_activation_day() {
        let mut c = setup("mainnet");
        join_as(&mut c, &alice(), None);
        for day in [0, 1] {
            set_time(day, 0);
            context(&alice(), NO_DEPOSIT);
            expect_err(ERR_WARMUP, || {
                c.check_in();
            });
        }
        set_time(2, 0);
        // A single member: idle day (goal 0), the check-in counts but is never a candidate.
        assert_eq!(
            check_in_as(&mut c, &alice(), 7),
            CheckInResult {
                day: 2,
                n: 1,
                goal: 0,
                in_closers: false,
            }
        );
        assert!(c.open.closers.is_empty());
        check_invariants(&c);
    }

    #[test]
    fn t04_second_check_in_same_day_rejected_next_day_ok() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        set_time(1, 0);
        check_in_as(&mut c, &alice(), 3);
        assert_eq!(
            check_in_events(),
            vec![
                json!({"account_id": "alice.near", "day": 1, "n": 1, "goal": 0,
                        "in_closers": false, "via": "direct"})
            ]
        );
        context(&alice(), NO_DEPOSIT);
        expect_err(ERR_ALREADY_CHECKED_IN, || {
            c.check_in();
        });
        assert_eq!(c.open.count, 1);

        set_time(2, 0);
        assert_eq!(check_in_as(&mut c, &alice(), 4).n, 1);
        let m = c.members.get(&alice()).cloned().expect("member");
        assert_eq!(
            (
                m.last_checkin,
                m.checkins,
                m.personal_streak,
                m.best_personal_streak
            ),
            (Some(2), 2, 2, 2)
        );
        // Day 3 skipped: the personal streak restarts, the best stays.
        set_time(4, 0);
        check_in_as(&mut c, &alice(), 5);
        let m = c.members.get(&alice()).cloned().expect("member");
        assert_eq!(
            (
                m.last_checkin,
                m.checkins,
                m.personal_streak,
                m.best_personal_streak
            ),
            (Some(4), 3, 1, 2)
        );
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_MEMBER")]
    fn t04_check_in_by_non_member() {
        let mut c = setup("demo");
        check_in_as(&mut c, &alice(), 2);
    }

    // ---- 11–12: closers (R5) ----

    /// `n` members join on day 0 (demo, active from day 1) and the time moves to day 1.
    fn members_active_on_day1(c: &mut Contract, n: u32) {
        for i in 0..n {
            join_as(c, &user(i), None);
        }
        set_time(1, 0);
    }

    /// 10 active → goal max(3, ⌈10 × 0.6⌉) = 6, K = 5.
    #[test]
    fn t11_two_check_ins_in_one_block_only_first_is_candidate() {
        let mut c = setup("demo");
        members_active_on_day1(&mut c, 10);
        let r = [
            check_in_as(&mut c, &user(0), 100),
            check_in_as(&mut c, &user(1), 100),
            check_in_as(&mut c, &user(2), 101),
        ];
        assert_eq!(c.open.goal, 6);
        assert_eq!(in_closers(&r), vec![true, false, true]);
        assert_eq!(r.map(|r| r.n), [1, 2, 3]);
        assert_eq!(c.open.closers, vec![user(0), user(2)]);
        assert_eq!(c.open.closer_height, 101);
    }

    #[test]
    fn t11_five_in_one_block_give_one_candidate() {
        let mut c = setup("demo");
        members_active_on_day1(&mut c, 10);
        let r: Vec<CheckInResult> = (0..5).map(|i| check_in_as(&mut c, &user(i), 200)).collect();
        assert_eq!(in_closers(&r), vec![true, false, false, false, false]);
        assert_eq!(c.open.closers, vec![user(0)]);
        assert!(check_in_as(&mut c, &user(5), 201).in_closers);
        assert_eq!(c.open.closers, vec![user(0), user(5)]);
    }

    /// Candidates up to `count == goal` (6) slide through a window of K = 5; later check-ins are
    /// never candidates.
    #[test]
    fn t12_window_slides_until_goal_then_freezes() {
        let mut c = setup("demo");
        members_active_on_day1(&mut c, 10);
        let r: Vec<CheckInResult> = (0..10)
            .map(|i| check_in_as(&mut c, &user(i), 300 + u64::from(i)))
            .collect();
        assert_eq!(
            in_closers(&r),
            vec![
                true, true, true, true, true, true, false, false, false, false
            ]
        );
        assert_eq!(c.open.closers, (1..=5).map(user).collect::<Vec<_>>());
        assert_eq!(c.open.closer_height, 305);
        check_invariants(&c);
    }

    /// 4 active → goal max(3, ⌈4 × 0.6⌉) = 3 < K: the window never fills.
    #[test]
    fn t12_goal_below_k() {
        let mut c = setup("demo");
        members_active_on_day1(&mut c, 4);
        let r: Vec<CheckInResult> = (0..4)
            .map(|i| check_in_as(&mut c, &user(i), 400 + u64::from(i)))
            .collect();
        assert_eq!(c.open.goal, 3);
        assert_eq!(in_closers(&r), vec![true, true, true, false]);
        assert_eq!(c.open.closers, vec![user(0), user(1), user(2)]);
    }

    // ---- 22a–c: signed check-in (S12) ----

    struct Vector {
        public_key: PublicKey,
        cases: Vec<Value>,
    }

    fn vector() -> Vector {
        let v: Value = serde_json::from_str(FIXTURE).expect("fixture JSON");
        Vector {
            public_key: v["public_key"]
                .as_str()
                .expect("public_key")
                .parse()
                .expect("ed25519 key"),
            cases: v["cases"].as_array().expect("cases").clone(),
        }
    }

    fn b64(case: &Value, field: &str) -> Vec<u8> {
        let v: Base64VecU8 = serde_json::from_value(case[field].clone()).expect("base64");
        v.0
    }

    /// Replays a fixture case through the contract, relayed by carol.
    fn replay(c: &mut Contract, case: &Value) -> CheckInResult {
        let account: AccountId = case["account_id"]
            .as_str()
            .expect("account")
            .parse()
            .expect("id");
        let day = u32::try_from(case["day"].as_u64().expect("day")).expect("u32");
        signed(
            c,
            &carol(),
            &account,
            day,
            &b64(case, "nonce_b64"),
            &b64(case, "signature_b64"),
        )
    }

    /// The vector (account alice.near, day 42, recipient lastcall.near = the harness contract).
    fn alice_with_vector_key_on_day42(c: &mut Contract, key: &PublicKey) {
        set_time(40, 0);
        join_as(c, &alice(), Some(key.clone()));
        set_time(42, 0);
    }

    #[test]
    fn t22a_valid_vector_signature_checks_in() {
        let v = vector();
        let mut c = setup("demo");
        alice_with_vector_key_on_day42(&mut c, &v.public_key);
        let valid = v
            .cases
            .iter()
            .find(|k| k["name"] == "valid")
            .expect("valid case");
        assert_eq!(
            replay(&mut c, valid),
            CheckInResult {
                day: 42,
                n: 1,
                goal: 0,
                in_closers: false,
            }
        );
        assert_eq!(
            check_in_events(),
            vec![
                json!({"account_id": "alice.near", "day": 42, "n": 1, "goal": 0,
                        "in_closers": false, "via": "signed"})
            ]
        );
        let m = c.members.get(&alice()).cloned().expect("member");
        assert_eq!((m.last_checkin, m.checkins), (Some(42), 1));
    }

    /// Every negative case of the vector at contract level; afterwards the valid one still passes.
    #[test]
    fn t22b_vector_negative_cases_rejected() {
        let v = vector();
        let mut c = setup("demo");
        alice_with_vector_key_on_day42(&mut c, &v.public_key);
        // bob holds the same key: only the message (account id) differs.
        set_time(40, 0);
        join_as(&mut c, &bob(), Some(v.public_key.clone()));
        set_time(42, 0);

        let mut seen = Vec::new();
        for case in &v.cases {
            let name = case["name"].as_str().expect("name");
            let key: Option<PublicKey> = case
                .get("public_key")
                .map(|k| k.as_str().expect("key").parse().expect("public key"));
            match name {
                "valid" => continue,
                "non_ed25519_key" => {
                    context(&alice(), ONE_YOCTO);
                    expect_err(ERR_BAD_KEY, || c.set_checkin_key(key.clone()));
                }
                "wrong_key" => {
                    set_key(&mut c, &alice(), key.clone());
                    expect_err(ERR_BAD_SIGNATURE, || {
                        replay(&mut c, case);
                    });
                    set_key(&mut c, &alice(), Some(v.public_key.clone()));
                }
                "day_plus_one" => expect_err(ERR_BAD_DAY, || {
                    replay(&mut c, case);
                }),
                "other_recipient" => {
                    // The vector reuses the signature made for lastcall.near and verifies it for
                    // evil.near: at contract level that is the same contract deployed at
                    // evil.near (recipient = current_account_id).
                    let recipient: AccountId = case["recipient"]
                        .as_str()
                        .expect("recipient")
                        .parse()
                        .expect("id");
                    testing_env!(
                        VMContextBuilder::new()
                            .current_account_id(recipient)
                            .predecessor_account_id(carol())
                            .block_timestamp(env::block_timestamp())
                            .storage_usage(env::storage_usage())
                            .build()
                    );
                    expect_err(ERR_BAD_SIGNATURE, || {
                        c.check_in_signed(
                            alice(),
                            42,
                            Base64VecU8::from(b64(case, "nonce_b64")),
                            Base64VecU8::from(b64(case, "signature_b64")),
                        );
                    });
                    // Back to the harness context (current account lastcall.near).
                    context(&carol(), NO_DEPOSIT);
                }
                "other_account_id" | "nonce_31_bytes" | "corrupted_signature" => {
                    expect_err(ERR_BAD_SIGNATURE, || {
                        replay(&mut c, case);
                    })
                }
                other => panic!("unhandled fixture case {other}"),
            }
            seen.push(name);
        }
        assert_eq!(seen.len(), 7);
        assert_eq!(c.open.count, 0);
        let valid = v
            .cases
            .iter()
            .find(|k| k["name"] == "valid")
            .expect("valid case");
        assert_eq!(replay(&mut c, valid).n, 1);
    }

    /// Own signatures (ed25519-dalek) with recipient = current_account_id.
    #[test]
    fn t22b_own_signatures_rejected_and_accepted() {
        let (sk, pk) = key_pair(1);
        let (other_sk, _) = key_pair(2);
        let nonce = [9u8; 32];
        let recipient = contract_id().to_string();
        let mut c = setup("demo");
        join_as(&mut c, &alice(), Some(pk));
        join_as(&mut c, &bob(), None);
        set_time(3, 0);
        let a = alice();

        let foreign = sign(&other_sk, &a, 3, nonce, &recipient);
        expect_err(ERR_BAD_SIGNATURE, || {
            signed(&mut c, &carol(), &a, 3, &nonce, &foreign);
        });
        // The signed message says day 4, the call says day 3.
        let other_message = sign(&sk, &a, 4, nonce, &recipient);
        expect_err(ERR_BAD_SIGNATURE, || {
            signed(&mut c, &carol(), &a, 3, &nonce, &other_message);
        });
        let other_recipient = sign(&sk, &a, 3, nonce, "other.near");
        expect_err(ERR_BAD_SIGNATURE, || {
            signed(&mut c, &carol(), &a, 3, &nonce, &other_recipient);
        });
        let good = sign(&sk, &a, 3, nonce, &recipient);
        expect_err(ERR_BAD_SIGNATURE, || {
            signed(&mut c, &carol(), &a, 3, &nonce[..31], &good);
        });
        expect_err(ERR_BAD_SIGNATURE, || {
            signed(&mut c, &carol(), &a, 3, &nonce, &good[..63]);
        });
        // A valid signature for yesterday.
        let yesterday = sign(&sk, &a, 2, nonce, &recipient);
        expect_err(ERR_BAD_DAY, || {
            signed(&mut c, &carol(), &a, 2, &nonce, &yesterday);
        });
        let for_bob = sign(&sk, &bob(), 3, nonce, &recipient);
        expect_err(ERR_NO_CHECKIN_KEY, || {
            signed(&mut c, &carol(), &bob(), 3, &nonce, &for_bob);
        });
        let for_carol = sign(&sk, &carol(), 3, nonce, &recipient);
        expect_err(ERR_NOT_MEMBER, || {
            signed(&mut c, &bob(), &carol(), 3, &nonce, &for_carol);
        });
        assert_eq!(c.open.count, 0);

        let r = signed(&mut c, &carol(), &a, 3, &nonce, &good);
        assert_eq!((r.day, r.n), (3, 1));
        check_invariants(&c);
    }

    #[test]
    fn t22c_signed_and_direct_share_one_check_in_a_day() {
        let (sk, pk) = key_pair(1);
        let nonce = [5u8; 32];
        let recipient = contract_id().to_string();
        let mut c = setup("demo");
        join_as(&mut c, &alice(), Some(pk));
        let a = alice();

        set_time(1, 0);
        signed(
            &mut c,
            &bob(),
            &a,
            1,
            &nonce,
            &sign(&sk, &a, 1, nonce, &recipient),
        );
        context(&a, NO_DEPOSIT);
        expect_err(ERR_ALREADY_CHECKED_IN, || {
            c.check_in();
        });

        set_time(2, 0);
        check_in_as(&mut c, &a, 2);
        let sig = sign(&sk, &a, 2, nonce, &recipient);
        expect_err(ERR_ALREADY_CHECKED_IN, || {
            signed(&mut c, &bob(), &a, 2, &nonce, &sig);
        });
        assert_eq!(c.members.get(&a).map(|m| m.checkins), Some(2));
    }

    #[test]
    fn t22c_set_checkin_key_none_disables_the_signed_path() {
        let (sk, pk) = key_pair(1);
        let (new_sk, new_pk) = key_pair(3);
        let nonce = [5u8; 32];
        let recipient = contract_id().to_string();
        let mut c = setup("demo");
        join_as(&mut c, &alice(), Some(pk));
        let a = alice();

        // No auto-settle in set_checkin_key: day 3 stays unsettled.
        set_time(3, 0);
        set_key(&mut c, &a, None);
        assert_eq!(c.last_settled, None);
        assert_eq!(c.members.get(&a).map(|m| m.checkin_key.clone()), Some(None));
        let sig = sign(&sk, &a, 3, nonce, &recipient);
        expect_err(ERR_NO_CHECKIN_KEY, || {
            signed(&mut c, &bob(), &a, 3, &nonce, &sig);
        });

        // A new key: the old one no longer signs, the new one does.
        set_key(&mut c, &a, Some(new_pk.clone()));
        assert_eq!(
            c.members.get(&a).map(|m| m.checkin_key.clone()),
            Some(Some(new_pk))
        );
        expect_err(ERR_BAD_SIGNATURE, || {
            signed(&mut c, &bob(), &a, 3, &nonce, &sig);
        });
        let r = signed(
            &mut c,
            &bob(),
            &a,
            3,
            &nonce,
            &sign(&new_sk, &a, 3, nonce, &recipient),
        );
        assert_eq!(r.day, 3);
    }

    #[test]
    fn t22c_set_checkin_key_errors() {
        let mut c = setup("demo");
        join_as(&mut c, &alice(), None);
        context(&alice(), NO_DEPOSIT);
        expect_err(ERR_ONE_YOCTO, || c.set_checkin_key(None));
        context(&alice(), yocto(2));
        expect_err(ERR_ONE_YOCTO, || c.set_checkin_key(None));
        context(&bob(), ONE_YOCTO);
        expect_err(ERR_NOT_MEMBER, || c.set_checkin_key(None));
        let mut secp = vec![1u8];
        secp.extend([7u8; 64]);
        let secp = PublicKey::try_from(secp).expect("secp256k1 key shape");
        context(&alice(), ONE_YOCTO);
        expect_err(ERR_BAD_KEY, || c.set_checkin_key(Some(secp)));
        assert_eq!(
            c.members.get(&alice()).map(|m| m.checkin_key.clone()),
            Some(None)
        );
        set_key(&mut c, &alice(), Some(ed25519_key()));
        assert_eq!(
            c.members.get(&alice()).map(|m| m.checkin_key.clone()),
            Some(Some(ed25519_key()))
        );
    }
}
