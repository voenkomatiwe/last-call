//! NEP-413 payload and signature check for `check_in_signed` (spec S12). Owner: C4.
//!
//! Primary source: NEP-413, <https://github.com/near/NEPs/blob/master/neps/nep-0413.md>.
//! The signed bytes are `sha256(borsh(u32 tag) ++ borsh(Payload))` with
//! `Payload { message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String> }`
//! and `tag = 2^31 + 413`; the signature is plain ed25519 over that 32-byte hash.

use near_sdk::{AccountId, PublicKey, env};

/// NEP-413 prefix tag `2^31 + 413`.
pub const NEP413_TAG: u32 = 2_147_484_061;

/// Borsh payload of S12: tag `2^31 + 413`, message
/// `{"action":"check_in","account_id":"<acct>","day":<day>}`, `[u8; 32]` nonce without a length
/// prefix, recipient, `callback_url = None`.
///
/// Borsh rules used: `u32` is 4 bytes little-endian; a string is its `u32` byte length followed by
/// its UTF-8 bytes; a fixed array is its bytes with no length; `None` is the single byte `0x00`.
/// The account id needs no JSON escaping: NEAR account ids contain only `a-z 0-9 . _ -`.
pub fn payload_bytes(
    account_id: &AccountId,
    day: u32,
    nonce: &[u8; 32],
    recipient: &AccountId,
) -> Vec<u8> {
    let message = format!(
        r#"{{"action":"check_in","account_id":"{}","day":{}}}"#,
        account_id.as_str(),
        day
    );
    let recipient = recipient.as_str();
    let mut out = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    out.extend_from_slice(&NEP413_TAG.to_le_bytes());
    push_borsh_str(&mut out, &message);
    out.extend_from_slice(nonce);
    push_borsh_str(&mut out, recipient);
    out.push(0); // callback_url: Option<String> = None
    out
}

/// Borsh string: `u32` little-endian byte length, then the bytes. Both callers pass strings far
/// below `u32::MAX` bytes (an account id is at most 64 bytes).
fn push_borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// `nonce.len() == 32 && signature.len() == 64`, ed25519 key only,
/// `ed25519_verify(sig, sha256(payload), pk)`. Never panics: any malformed input gives `false`.
pub fn verify(
    account_id: &AccountId,
    day: u32,
    nonce: &[u8],
    signature: &[u8],
    recipient: &AccountId,
    key: &PublicKey,
) -> bool {
    let Ok(nonce) = <&[u8; 32]>::try_from(nonce) else {
        return false;
    };
    let Ok(signature) = <&[u8; 64]>::try_from(signature) else {
        return false;
    };
    let Some(public_key) = ed25519_key_bytes(key) else {
        return false;
    };
    let hash = env::sha256(payload_bytes(account_id, day, nonce, recipient));
    env::ed25519_verify(signature, hash, public_key)
}

/// The 32 key bytes of an ed25519 `PublicKey` (curve byte `0`, then exactly 32 bytes); `None` for
/// any other curve (secp256k1 `1`, ml-dsa-65 `2`) or length.
pub fn ed25519_key_bytes(key: &PublicKey) -> Option<&[u8; 32]> {
    match key.as_bytes() {
        [0, data @ ..] => <&[u8; 32]>::try_from(data).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::borsh::{self, BorshSerialize};
    use near_sdk::json_types::Base64VecU8;
    use near_sdk::serde::{Deserialize, Serialize};
    use near_sdk::serde_json;

    /// Seed of the vector's signing key (32 ASCII bytes).
    const SEED: [u8; 32] = *b"last-call/nep413/test-vector/v01";
    /// Seed of the "someone else's key" case.
    const OTHER_SEED: [u8; 32] = *b"last-call/nep413/other-key/v0001";
    const FIXTURE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/nep413.json");

    #[derive(Serialize, Deserialize, Debug)]
    #[serde(crate = "near_sdk::serde")]
    struct Fixture {
        seed_hex: String,
        public_key: PublicKey,
        cases: Vec<Case>,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    #[serde(crate = "near_sdk::serde")]
    struct Case {
        name: String,
        account_id: AccountId,
        day: u32,
        recipient: AccountId,
        nonce_b64: Base64VecU8,
        signature_b64: Base64VecU8,
        /// Only when it differs from the top-level `public_key`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_key: Option<PublicKey>,
        expected: bool,
    }

    /// NEP-413 `Payload` exactly as the NEP declares it, serialized by the borsh crate: an
    /// implementation independent of `payload_bytes`.
    #[derive(BorshSerialize)]
    #[borsh(crate = "near_sdk::borsh")]
    struct Nep413Payload {
        message: String,
        nonce: [u8; 32],
        recipient: String,
        callback_url: Option<String>,
    }

    /// `borsh(u32 2^31 + 413) ++ borsh(Payload)` built by the borsh crate.
    fn reference_payload(account_id: &str, day: u32, nonce: [u8; 32], recipient: &str) -> Vec<u8> {
        let payload = Nep413Payload {
            message: format!(r#"{{"action":"check_in","account_id":"{account_id}","day":{day}}}"#),
            nonce,
            recipient: recipient.to_string(),
            callback_url: None,
        };
        borsh::to_vec(&(2_147_484_061u32, payload)).expect("borsh into Vec")
    }

    fn signing_key(seed: &[u8; 32]) -> SigningKey {
        SigningKey::from_bytes(seed)
    }

    fn ed25519_public_key(key: &SigningKey) -> PublicKey {
        let mut bytes = vec![0u8];
        bytes.extend_from_slice(key.verifying_key().as_bytes());
        PublicKey::try_from(bytes).expect("valid ed25519 key")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn acc(s: &str) -> AccountId {
        s.parse().expect("valid account id")
    }

    /// Writes `tests/fixtures/nep413.json`. Run once: `cargo test nep413:: -- --ignored`.
    #[test]
    #[ignore = "writes tests/fixtures/nep413.json"]
    fn generate_nep413_fixture() {
        let key = signing_key(&SEED);
        let other = signing_key(&OTHER_SEED);
        let public_key = ed25519_public_key(&key);

        let account_id = "alice.near";
        let day = 42u32;
        let recipient = "lastcall.near";
        let mut nonce = [0u8; 32];
        for (i, b) in nonce.iter_mut().enumerate() {
            *b = i as u8;
        }

        // Sign the reference payload, not `payload_bytes`, so the vector does not depend on the
        // code under test. NEAR signs sha256 of the payload (NEP-413 "Signature", steps 4-5).
        let payload = reference_payload(account_id, day, nonce, recipient);
        assert_eq!(
            payload,
            payload_bytes(&acc(account_id), day, &nonce, &acc(recipient))
        );
        let hash = env::sha256(&payload);
        let signature = key.sign(&hash).to_bytes();

        let mut corrupted = signature;
        corrupted[0] ^= 0x01;

        // secp256k1 key (64 bytes) whose first 32 bytes are the valid ed25519 key: a check that
        // ignores the curve byte would accept it.
        let mut secp = vec![1u8];
        secp.extend_from_slice(key.verifying_key().as_bytes());
        secp.extend_from_slice(other.verifying_key().as_bytes());
        let secp256k1_key = PublicKey::try_from(secp).expect("valid secp256k1 key shape");
        assert!(secp256k1_key.to_string().starts_with("secp256k1:"));

        let valid = Case {
            name: "valid".into(),
            account_id: acc(account_id),
            day,
            recipient: acc(recipient),
            nonce_b64: Base64VecU8::from(nonce.to_vec()),
            signature_b64: Base64VecU8::from(signature.to_vec()),
            public_key: None,
            expected: true,
        };
        let negative = |name: &str| Case {
            name: name.into(),
            expected: false,
            ..valid.clone()
        };
        let cases = vec![
            valid.clone(),
            Case {
                public_key: Some(ed25519_public_key(&other)),
                ..negative("wrong_key")
            },
            Case {
                day: day + 1,
                ..negative("day_plus_one")
            },
            Case {
                recipient: acc("evil.near"),
                ..negative("other_recipient")
            },
            Case {
                account_id: acc("bob.near"),
                ..negative("other_account_id")
            },
            Case {
                nonce_b64: Base64VecU8::from(nonce[..31].to_vec()),
                ..negative("nonce_31_bytes")
            },
            Case {
                signature_b64: Base64VecU8::from(corrupted.to_vec()),
                ..negative("corrupted_signature")
            },
            Case {
                public_key: Some(secp256k1_key),
                ..negative("non_ed25519_key")
            },
        ];

        let fixture = Fixture {
            seed_hex: hex(&SEED),
            public_key,
            cases,
        };
        let mut json = serde_json::to_string_pretty(&fixture).expect("serialize fixture");
        json.push('\n');
        let path = std::path::Path::new(FIXTURE_PATH);
        std::fs::create_dir_all(path.parent().expect("fixture dir")).expect("create fixture dir");
        std::fs::write(path, json).expect("write fixture");
    }

    const FIXTURE_JSON: &str = include_str!("../tests/fixtures/nep413.json");

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE_JSON).expect("tests/fixtures/nep413.json must parse")
    }

    fn case(name: &str) -> (Case, PublicKey) {
        let f = fixture();
        let c = f
            .cases
            .into_iter()
            .find(|c| c.name == name)
            .expect("case in fixture");
        let key = c.public_key.clone().unwrap_or(f.public_key);
        (c, key)
    }

    fn verify_case(c: &Case, key: &PublicKey) -> bool {
        verify(
            &c.account_id,
            c.day,
            &c.nonce_b64.0,
            &c.signature_b64.0,
            &c.recipient,
            key,
        )
    }

    /// The named negative case is marked `false` in the file and `verify` rejects it.
    fn assert_rejected(name: &str) {
        let (c, key) = case(name);
        assert!(!c.expected, "{name} must be a negative case");
        assert!(!verify_case(&c, &key), "{name} must be rejected");
    }

    #[test]
    fn t22a_valid_signature_accepted() {
        let (c, key) = case("valid");
        assert!(c.expected);
        assert!(c.public_key.is_none());
        assert_eq!(
            key.to_string(),
            "ed25519:5Yc5tFNeVrSAvXBnLmaHmKTKrcVacTZ487Gczs4NGeAC"
        );
        assert!(verify_case(&c, &key));
    }

    #[test]
    fn t22b_wrong_key_rejected() {
        assert_rejected("wrong_key");
    }

    #[test]
    fn t22b_day_plus_one_rejected() {
        assert_rejected("day_plus_one");
    }

    #[test]
    fn t22b_other_recipient_rejected() {
        assert_rejected("other_recipient");
    }

    #[test]
    fn t22b_other_account_id_rejected() {
        assert_rejected("other_account_id");
    }

    #[test]
    fn t22b_nonce_31_bytes_rejected() {
        let (c, _) = case("nonce_31_bytes");
        assert_eq!(c.nonce_b64.0.len(), 31);
        assert_rejected("nonce_31_bytes");
    }

    #[test]
    fn t22b_corrupted_signature_rejected() {
        assert_rejected("corrupted_signature");
    }

    #[test]
    fn t22b_non_ed25519_key_rejected() {
        let (_, key) = case("non_ed25519_key");
        assert!(key.to_string().starts_with("secp256k1:"));
        assert_rejected("non_ed25519_key");
    }

    /// ml-dsa-65 keys (1952 bytes) are too large for the shared file; checked here.
    #[test]
    fn t22b_ml_dsa_65_key_rejected() {
        let (c, ed_key) = case("valid");
        let mut bytes = vec![2u8];
        bytes.extend_from_slice(&ed_key.as_bytes()[1..]);
        bytes.resize(1 + 1952, 0);
        let key = PublicKey::try_from(bytes).expect("valid ml-dsa-65 key shape");
        assert!(!verify_case(&c, &key));
    }

    /// Lengths other than 32 (nonce) and 64 (signature) give `false`, never a panic.
    #[test]
    fn t22b_bad_lengths_rejected() {
        let (c, key) = case("valid");
        let nonce = &c.nonce_b64.0;
        let sig = &c.signature_b64.0;
        let mut nonce33 = nonce.clone();
        nonce33.push(0);
        let mut sig65 = sig.clone();
        sig65.push(0);
        for (n, s) in [
            (&[][..], &sig[..]),
            (&nonce33[..], &sig[..]),
            (&nonce[..], &[][..]),
            (&nonce[..], &sig[..63]),
            (&nonce[..], &sig65[..]),
        ] {
            assert!(!verify(&c.account_id, c.day, n, s, &c.recipient, &key));
        }
    }

    /// Every case of the shared file matches its `expected`, and the file has exactly the cases
    /// the tests above name.
    #[test]
    fn t22_fixture_all_cases_match_expected() {
        let f = fixture();
        let names: Vec<&str> = f.cases.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "valid",
                "wrong_key",
                "day_plus_one",
                "other_recipient",
                "other_account_id",
                "nonce_31_bytes",
                "corrupted_signature",
                "non_ed25519_key",
            ]
        );
        for c in &f.cases {
            let key = c.public_key.as_ref().unwrap_or(&f.public_key);
            assert_eq!(verify_case(c, key), c.expected, "case {}", c.name);
        }
    }

    /// `seed_hex` derives the top-level `public_key` (what the TS side reproduces).
    #[test]
    fn t22_fixture_seed_derives_public_key() {
        let f = fixture();
        assert_eq!(f.seed_hex, hex(&SEED));
        assert_eq!(ed25519_public_key(&signing_key(&SEED)), f.public_key);
    }

    /// `payload_bytes` of the valid case against an explicit field-by-field byte list.
    #[test]
    fn t22_payload_bytes_matches_manual_layout() {
        let (c, _) = case("valid");
        let nonce: [u8; 32] = c.nonce_b64.0.clone().try_into().expect("32-byte nonce");
        let actual = payload_bytes(&c.account_id, c.day, &nonce, &c.recipient);

        let msg: &[u8] = br#"{"action":"check_in","account_id":"alice.near","day":42}"#;
        let recipient: &[u8] = b"lastcall.near";
        assert_eq!(msg.len(), 56);
        assert_eq!(recipient.len(), 13);

        let mut expected = Vec::new();
        expected.extend_from_slice(&[0x9d, 0x01, 0x00, 0x80]); // tag 2147484061 = 0x8000019d, LE
        expected.extend_from_slice(&[56, 0, 0, 0]); // message length, u32 LE
        expected.extend_from_slice(msg);
        expected.extend_from_slice(&[
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 31,
        ]); // nonce: 32 bytes, no length prefix
        expected.extend_from_slice(&[13, 0, 0, 0]); // recipient length, u32 LE
        expected.extend_from_slice(recipient);
        expected.push(0x00); // callback_url = None

        assert_eq!(actual, expected);
        assert_eq!(
            actual.len(),
            4 + (4 + msg.len()) + 32 + (4 + recipient.len()) + 1
        );
        assert_eq!(actual.len(), 114);
    }

    /// `payload_bytes` equals the borsh crate's serialization of the NEP-413 struct, including
    /// edge values of `day` and a 64-character account id.
    #[test]
    fn t22_payload_bytes_matches_borsh_reference() {
        let long = format!("{}.near", "a".repeat(59));
        assert_eq!(long.len(), 64);
        let nonce = [0xabu8; 32];
        for (account, day, recipient) in [
            ("alice.near", 42, "lastcall.near"),
            ("bob.near", 0, "lastcall.testnet"),
            (long.as_str(), u32::MAX, "x.near"),
        ] {
            assert_eq!(
                payload_bytes(&acc(account), day, &nonce, &acc(recipient)),
                reference_payload(account, day, nonce, recipient),
                "{account} {day} {recipient}"
            );
        }
    }
}
