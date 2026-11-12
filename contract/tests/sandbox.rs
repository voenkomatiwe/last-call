//! Sandbox integration tests (C11; spec S18 10/25/27/28/int, S5, S11, S12): the real wasm from
//! `cargo near build non-reproducible-wasm` in a real nearcore (near-sandbox 0.4.0 runs nearcore
//! 2.14.0), driven by near-api 0.8.7.
//!
//! Every test is `#[ignore = "sandbox"]`, so a plain `cargo test` stays fast and offline. Run:
//!
//! ```text
//! export CARGO_TARGET_DIR=target/c3
//! cargo near build non-reproducible-wasm
//! DYLD_LIBRARY_PATH=$(brew --prefix xz)/lib cargo test --test sandbox -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! The wasm is read from `LAST_CALL_WASM`, else `$CARGO_TARGET_DIR/near/last_call.wasm`, else
//! `target/near/last_call.wasm` (relative paths are taken from the crate root). Measurements (gas,
//! log bytes, storage, hero slots) are printed on lines starting with `C11` (`--nocapture`).
//!
//! Time: `new` fixes `launch_ns`; `sandbox_fast_forward` moves the block timestamp by about
//! (min + max block production delay) / 2 per block. The node runs with a 3 s maximum delay (~1.56 s
//! per fast-forwarded block instead of ~0.3 s; normal block production is unchanged) and one epoch
//! of 100 000 blocks (see `Node::start`); `Node` calibrates the step once and `goto_day` lands just
//! past the start of the wanted day (`C11_DEBUG=1` prints every jump). Long backlogs use a deployment with `day_length_s = 10` (the
//! S3 minimum); everything else uses the demo set (60 s days). The hero distribution test takes
//! `LAST_CALL_HERO_DAYS` (draws, default 200) and `LAST_CALL_HERO_INSTANCES` (deployments, default 4).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ed25519_dalek::{Signer as _, SigningKey};
use last_call::config::{AUTO_SETTLE_CAP, MAX_MEMBER_BYTES, MAX_SETTLE_DAYS, PICK_HERO_GAS};
use near_api::types::crypto::public_key::ED25519PublicKey;
use near_api::types::transaction::actions::{
    AddKeyAction, CreateAccountAction, FunctionCallAction, TransferAction,
};
use near_api::types::transaction::result::{ExecutionFinalResult, ExecutionOutcome};
use near_api::types::{
    AccessKey, AccessKeyPermission, Action, CryptoHash, Reference, TxExecutionStatus,
};
use near_api::{
    Account, AccountId, Chain, Contract, NearGas, NearToken, NetworkConfig, PublicKey, Signer,
    Transaction,
};
use near_sandbox::config::{DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use near_sandbox::{Sandbox, SandboxConfig};
use near_sdk::base64::Engine as _;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

const PARAMS: &str = include_str!("../../config/params.json");

/// 1 NEAR in yoctoNEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const ONE_YOCTO: u128 = 1;
/// `member_storage_deposit` of every parameter set: 10^22 yoctoNEAR (0.01 NEAR).
const MEMBER_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
/// yoctoNEAR per byte of storage (protocol constant).
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// LAST every player gets from the initial holder: 10^22 (10 000 LAST, 18 decimals).
const FUND: u128 = 10_000_000_000_000_000_000_000;
/// The bps base `B`.
const BPS: u128 = 10_000;
/// `near-sandbox` waits 30 s for the target height of one `fast_forward`; 2 000 blocks take well
/// under a second with one long epoch (~17 s with the default 60-block epochs).
const FF_CHUNK: u64 = 2_000;
/// 1 Tgas.
const TGAS: u64 = 1_000_000_000_000;

// ---- Small helpers ----

/// The contract wasm (see the module docs for the lookup order).
fn wasm() -> Vec<u8> {
    let path = std::env::var_os("LAST_CALL_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let target = std::env::var_os("CARGO_TARGET_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("target"));
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(target)
                .join("near")
                .join("last_call.wasm")
        });
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read the contract wasm at {} ({e}). Build it first with \
             `cargo near build non-reproducible-wasm` (same CARGO_TARGET_DIR), or set LAST_CALL_WASM.",
            path.display()
        )
    })
}

/// One parameter set of `config/params.json` (S2).
fn params(set: &str) -> Value {
    let all: Value = serde_json::from_str(PARAMS).expect("config/params.json");
    all[set].clone()
}

/// A `U128` JSON string.
fn u(v: &Value) -> u128 {
    v.as_str()
        .unwrap_or_else(|| panic!("expected a U128 string, got {v}"))
        .parse()
        .unwrap_or_else(|e| panic!("bad U128 {v}: {e}"))
}

/// A JSON number.
fn num(v: &Value) -> u64 {
    v.as_u64()
        .unwrap_or_else(|| panic!("expected a number, got {v}"))
}

fn tgas(gas: u64) -> f64 {
    gas as f64 / TGAS as f64
}

fn fc(method: &str, args: Value, tgas: u64, deposit: u128) -> Action {
    Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: method.to_owned(),
        args: serde_json::to_vec(&args).expect("args"),
        gas: NearGas::from_tgas(tgas),
        deposit: NearToken::from_yoctonear(deposit),
    }))
}

/// NEP-297 events (`EVENT_JSON:` logs) of one standard and name.
fn events_of<'a>(
    logs: impl IntoIterator<Item = &'a String>,
    standard: &str,
    event: &str,
) -> Vec<Value> {
    logs.into_iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).expect("event JSON"))
        .filter(|e| e["standard"] == standard && e["event"] == event)
        .collect()
}

/// `budget / (count + jackpot_mult)` of a successful day (S8), computed directly from the inputs.
fn per_share(
    pot: u128,
    emit_bps: u128,
    streak_after: u128,
    cap: u128,
    step: u128,
    count: u128,
    mult: u128,
) -> u128 {
    let mult_bps = BPS + streak_after.min(cap) * step;
    pot * emit_bps * mult_bps / (BPS * BPS) / (count + mult)
}

/// A check-in key: ed25519 from a fixed test seed (ephemeral sandbox data, not a secret).
fn checkin_key(i: u8) -> SigningKey {
    let mut seed = *b"last-call/c11/sandbox/checkin/00";
    seed[31] = b'0' + i;
    SigningKey::from_bytes(&seed)
}

/// `ed25519:<base58>` of a check-in key, as `join(checkin_key)` takes it.
fn public_key_str(key: &SigningKey) -> String {
    PublicKey::ED25519(ED25519PublicKey(key.verifying_key().to_bytes())).to_string()
}

/// `check_in_signed` arguments (S12). The NEP-413 hash comes from near-api's own `NEP413Payload`
/// (an implementation independent of the contract's `nep413.rs`), the signature from ed25519-dalek.
fn signed_check_in_args(
    key: &SigningKey,
    account: &AccountId,
    day: u32,
    contract: &AccountId,
    salt: u8,
) -> Value {
    let mut nonce = [salt; 32];
    nonce[0] = day as u8;
    let payload = near_api::signer::NEP413Payload {
        message: format!(r#"{{"action":"check_in","account_id":"{account}","day":{day}}}"#),
        nonce,
        recipient: contract.to_string(),
        callback_url: None,
    };
    let hash = payload.compute_hash().expect("NEP-413 hash");
    let signature = key.sign(&hash.0);
    json!({
        "account_id": account,
        "day": day,
        "nonce": BASE64.encode(nonce),
        "signature": BASE64.encode(signature.to_bytes()),
    })
}

// ---- Transaction results ----

/// A finished transaction (all receipts executed).
struct Tx(ExecutionFinalResult);

impl Tx {
    fn ok(&self) -> bool {
        self.0.is_success()
    }

    /// The failure as text (contains e.g. `Smart contract panicked: ERR_BACKLOG`), or "".
    fn failure(&self) -> String {
        match self.0.clone().into_result() {
            Ok(_) => String::new(),
            Err(e) => e.to_string(),
        }
    }

    #[track_caller]
    fn expect_ok(self, what: &str) -> Self {
        assert!(self.ok(), "{what} failed: {}", self.failure());
        self
    }

    #[track_caller]
    fn expect_err(&self, what: &str, needle: &str) {
        assert!(
            !self.ok(),
            "{what}: expected a failure with {needle}, got success"
        );
        let f = self.failure();
        assert!(f.contains(needle), "{what}: expected {needle}, got {f}");
    }

    /// The JSON return value of the transaction (the last receipt of the call chain).
    fn value(&self) -> Value {
        self.0.clone().json::<Value>().expect("JSON return value")
    }

    /// The receipt the transaction was converted into: the function call(s) themselves.
    fn main(&self) -> &ExecutionOutcome {
        let id = self.0.outcome().receipt_ids[0];
        self.0
            .receipt_outcomes()
            .iter()
            .find(|o| o.transaction_hash == id)
            .expect("main receipt outcome")
    }

    /// Gas burnt by the main receipt.
    fn gas(&self) -> u64 {
        self.main().gas_burnt.as_gas()
    }

    fn logs(&self) -> Vec<String> {
        self.0.logs().into_iter().map(str::to_owned).collect()
    }

    fn events(&self, standard: &str, event: &str) -> Vec<Value> {
        events_of(&self.logs(), standard, event)
    }

    /// Receipts executed on `account` other than the main one (e.g. `pick_hero`).
    fn other_receipts_on(&self, account: &AccountId) -> Vec<&ExecutionOutcome> {
        let main = self.main().transaction_hash;
        self.0
            .receipt_outcomes()
            .iter()
            .filter(|o| o.executor_id == *account && o.transaction_hash != main)
            .collect()
    }
}

// ---- The node and the accounts ----

/// Everything needed to sign and send; cheap to clone.
#[derive(Clone)]
struct Client {
    net: NetworkConfig,
    root: AccountId,
    root_signer: Arc<Signer>,
    /// Signs for every account a test creates: one key generated at runtime (near-api caches nonces
    /// per account and key, so one `Signer` serves all of them).
    signer: Arc<Signer>,
    key: PublicKey,
}

impl Client {
    fn sub(&self, name: &str) -> AccountId {
        format!("{name}.{}", self.root).parse().expect("account id")
    }

    fn signer_for(&self, account: &AccountId) -> Arc<Signer> {
        if *account == self.root {
            self.root_signer.clone()
        } else {
            self.signer.clone()
        }
    }

    async fn create_account(&self, id: &AccountId, near: u128) {
        let actions = vec![
            Action::CreateAccount(CreateAccountAction {}),
            Action::Transfer(TransferAction {
                deposit: NearToken::from_yoctonear(near * NEAR),
            }),
            Action::AddKey(Box::new(AddKeyAction {
                public_key: self.key,
                access_key: AccessKey {
                    nonce: 0.into(),
                    permission: AccessKeyPermission::FullAccess,
                },
            })),
        ];
        let root = self.root.clone();
        self.send(&root, id, actions, TxExecutionStatus::Final)
            .await
            .expect_ok("create account");
    }

    async fn send(
        &self,
        from: &AccountId,
        to: &AccountId,
        actions: Vec<Action>,
        wait: TxExecutionStatus,
    ) -> Tx {
        // A freshly started node rejected the very first transaction once with an empty
        // `InvalidTransaction`; such a transaction never ran, so it is safe to sign and send again.
        let mut attempt = 0;
        loop {
            attempt += 1;
            let result = Transaction::construct(from.clone(), to.clone())
                .add_actions(actions.clone())
                .with_signer(self.signer_for(from))
                .wait_until(wait)
                .send_to(&self.net)
                .await;
            match result {
                Ok(result) => return Tx(result.into_full().expect("full execution outcome")),
                Err(e) if attempt < 3 && e.to_string().contains("InvalidTransaction") => {
                    println!("C11 note: {from} → {to} rejected ({e}); sending again");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                Err(e) => panic!("{from} → {to}: RPC error {e}"),
            }
        }
    }

    async fn near_balance(&self, account: &AccountId) -> u128 {
        Account(account.clone())
            .view()
            .fetch_from(&self.net)
            .await
            .expect("view_account")
            .data
            .amount
            .as_yoctonear()
    }

    async fn storage_usage(&self, account: &AccountId) -> u64 {
        Account(account.clone())
            .view()
            .fetch_from(&self.net)
            .await
            .expect("view_account")
            .data
            .storage_usage
    }

    async fn access_keys(&self, account: &AccountId) -> Vec<PublicKey> {
        Account(account.clone())
            .list_keys()
            .fetch_from(&self.net)
            .await
            .expect("view_access_key_list")
            .data
            .into_iter()
            .map(|(key, _)| key)
            .collect()
    }

    async fn block_height(&self, hash: CryptoHash) -> u64 {
        Chain::block()
            .at(Reference::AtBlockHash(hash))
            .fetch_from(&self.net)
            .await
            .expect("block")
            .header
            .height
    }

    /// `EXPERIMENTAL_receipt` → JSON, or `None` if the node does not serve it.
    async fn receipt_json(&self, id: CryptoHash) -> Option<Value> {
        let receipt = Transaction::receipt(id).fetch_from(&self.net).await.ok()?;
        serde_json::to_value(&receipt).ok()
    }
}

/// Waits until fast-forwarded blocks stop coming. `Sandbox::fast_forward` returns once the head
/// reaches the target height; without this wait one deployment found its game clock 5 days (the
/// 312 s of the 200-block calibration) past `launch_ns` a few seconds after `new`, most likely
/// because fast-forwarded blocks were still coming. Fast-forwarded blocks come at >1000 per second,
/// normal ones at ~8.
async fn wait_fast_forward_done(net: &NetworkConfig) {
    let height = || async { Chain::block_number().fetch_from(net).await.expect("height") };
    let mut last = height().await;
    for _ in 0..600 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let now = height().await;
        if now <= last + 10 {
            return;
        }
        last = now;
    }
    panic!("fast-forwarded blocks keep coming after 3 minutes");
}

/// A running sandbox node. Dropping it kills the `near-sandbox` process.
struct Node {
    sandbox: Sandbox,
    client: Client,
    /// Network milliseconds one fast-forwarded block adds to the block timestamp: measured at start
    /// and refined by `goto_day`.
    calibrated_ms_per_block: f64,
    ms_per_block: Mutex<f64>,
}

impl Node {
    async fn start() -> Node {
        // A fast-forwarded block advances the timestamp by (min + max block production delay) / 2:
        // ~0.3 s with the default 0.5 s maximum, ~1.5 s with 3 s (normal block production is
        // unchanged and a jump still lands within ~2 s of a day boundary). With the default epoch of
        // 60 blocks every epoch start costs time and the node sometimes stops at the first block of
        // an epoch for seconds to minutes (seen at heights 121, 1261, 2461, 5821, 16681); since block
        // timestamps follow the wall clock, such a pause also moves the game clock. One epoch of
        // 100 000 blocks avoids both: 600 ten-second days take ~1 s instead of 35 s to 8 min.
        let config = SandboxConfig {
            additional_config: Some(json!({
                "consensus": {"max_block_production_delay": {"secs": 3, "nanos": 0}}
            })),
            additional_genesis: Some(json!({ "epoch_length": 100_000 })),
            ..SandboxConfig::default()
        };
        let sandbox = Sandbox::start_sandbox_with_config(config).await.expect(
            "start near-sandbox (on macOS it needs liblzma: DYLD_LIBRARY_PATH=$(brew --prefix xz)/lib)",
        );
        let net =
            NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse().expect("rpc url"));
        let root: AccountId = DEFAULT_GENESIS_ACCOUNT.as_str().parse().expect("root id");
        let root_signer = Signer::from_secret_key(
            DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
                .parse()
                .expect("root key"),
        )
        .expect("root signer");
        let secret = near_api::signer::generate_secret_key().expect("key");
        let key = secret.public_key();
        let signer = Signer::from_secret_key(secret).expect("signer");
        // Calibrate the fast-forward step from block timestamps before anything is deployed.
        let b0 = Chain::block().fetch_from(&net).await.expect("block");
        sandbox.fast_forward(200).await.expect("fast_forward");
        wait_fast_forward_done(&net).await;
        let b1 = Chain::block().fetch_from(&net).await.expect("block");
        let ms = (b1.header.timestamp - b0.header.timestamp) as f64
            / 1e6
            / (b1.header.height - b0.header.height) as f64;
        println!("C11 node: fast-forward adds {ms:.0} ms of block time per block");
        Node {
            sandbox,
            client: Client {
                net,
                root,
                root_signer,
                signer,
                key,
            },
            calibrated_ms_per_block: ms,
            ms_per_block: Mutex::new(ms),
        }
    }

    async fn height(&self) -> u64 {
        Chain::block_number()
            .fetch_from(&self.client.net)
            .await
            .expect("block height")
    }

    /// `sandbox_fast_forward` in chunks. `near-sandbox` gives up polling for the target height after
    /// 30 s; the node sometimes pauses for a minute or more, so on that error keep waiting.
    async fn fast_forward(&self, blocks: u64) {
        let mut left = blocks;
        while left > 0 {
            let n = left.min(FF_CHUNK);
            let target = self.height().await + n;
            if let Err(e) = self.sandbox.fast_forward(n).await {
                println!("C11 node: {e}; waiting up to 10 min for height {target}");
                let t = Instant::now();
                while self.height().await < target {
                    assert!(
                        t.elapsed().as_secs() < 600,
                        "the node stopped producing blocks"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
            left -= n;
        }
        wait_fast_forward_done(&self.client.net).await;
    }

    /// Creates `name.sandbox` and the initial holder `holder-<name>.sandbox`, deploys the wasm and
    /// calls `new` with the parameter set `set` (optionally with another `day_length_s`).
    async fn deploy(&self, name: &str, set: &str, day_length_s: Option<u64>) -> Game {
        self.create_game_accounts(name).await;
        deploy_contract(
            self.client.clone(),
            name.to_owned(),
            set.to_owned(),
            day_length_s,
        )
        .await
    }

    /// Several deployments whose `new` calls run concurrently, so that their launches (and day
    /// boundaries) fall within a block or two of each other.
    async fn deploy_many(
        &self,
        names: &[String],
        set: &str,
        day_length_s: Option<u64>,
    ) -> Vec<Game> {
        for name in names {
            self.create_game_accounts(name).await;
        }
        let handles: Vec<_> = names
            .iter()
            .map(|name| {
                let (client, name, set) = (self.client.clone(), name.clone(), set.to_owned());
                tokio::spawn(deploy_contract(client, name, set, day_length_s))
            })
            .collect();
        let mut games = Vec::new();
        for h in handles {
            games.push(h.await.expect("deploy task"));
        }
        games
    }

    /// `name.sandbox` (the contract) and `holder-<name>.sandbox` (the initial holder).
    async fn create_game_accounts(&self, name: &str) {
        let c = &self.client;
        c.create_account(&c.sub(name), 50).await;
        c.create_account(&c.sub(&format!("holder-{name}")), 100)
            .await;
    }

    /// Fast-forwards until `today == target`, landing one or two blocks past the day boundary.
    async fn goto_day(&self, g: &Game, target: u32) {
        let today = self.goto_day_at_least(g, target).await;
        assert_eq!(
            today, target,
            "overshot the day: the node paused (block timestamps follow the wall clock, so a pause \
             moves the game clock); rerun the test"
        );
    }

    /// `goto_day` that returns `false` instead of failing when a node pause overshot the day.
    async fn try_goto_day(&self, g: &Game, target: u32) -> bool {
        self.goto_day_at_least(g, target).await == target
    }

    /// Fast-forwards until `today >= target` (more only after a node pause); returns today.
    async fn goto_day_at_least(&self, g: &Game, target: u32) -> u32 {
        loop {
            let (today, left) = g.clock().await;
            if today >= target {
                return today;
            }
            let ms_per_block = *self.ms_per_block.lock().unwrap();
            let need = (u64::from(target - today - 1) * g.day_ms + left) as f64;
            // Long jumps go 80% of the way first, so an error in the estimate cannot overshoot.
            let aim = if need > 2.0 * g.day_ms as f64 {
                0.8 * need
            } else {
                need + 0.25 * ms_per_block
            };
            let blocks = (aim / ms_per_block).ceil() as u64;
            let before = u64::from(today) * g.day_ms + (g.day_ms - left);
            let t = Instant::now();
            self.fast_forward(blocks.max(1)).await;
            let real = t.elapsed().as_secs_f64();
            let (t1, l1) = g.clock().await;
            let after = u64::from(t1) * g.day_ms + (g.day_ms - l1);
            let measured = (after - before) as f64 / blocks as f64;
            if std::env::var_os("C11_DEBUG").is_some() {
                eprintln!(
                    "goto {target}: day {today} +{left} ms → ff {blocks} blocks ({real:.1} s) → day {t1} \
                     +{l1} ms; {measured:.0} ms/block (estimate {ms_per_block:.0})"
                );
            }
            if blocks >= 20 {
                // Keep the estimate near the calibration: one odd sample must not cause an overshoot.
                let calibrated = self.calibrated_ms_per_block;
                *self.ms_per_block.lock().unwrap() =
                    measured.clamp(0.8 * calibrated, 1.25 * calibrated);
            }
        }
    }

    /// Today, moving to the next day first if less than `min_left_ms` of today is left.
    async fn fresh_day(&self, g: &Game, min_left_ms: u64) -> u32 {
        let (today, left) = g.clock().await;
        if left >= min_left_ms {
            return today;
        }
        self.goto_day(g, today + 1).await;
        today + 1
    }
}

/// Deploys the wasm to the existing account `name.sandbox` and calls `new` with the parameter set
/// `set` (optionally with another `day_length_s`); `holder-<name>.sandbox` is the initial holder.
async fn deploy_contract(c: Client, name: String, set: String, day_length_s: Option<u64>) -> Game {
    let contract = c.sub(&name);
    let holder = c.sub(&format!("holder-{name}"));
    let p = params(&set);
    let mut config = p["config"].clone();
    if let Some(s) = day_length_s {
        config["day_length_s"] = json!(s);
    }
    let args = json!({
        "config": config,
        "total_supply": p["total_supply"],
        "pot_bps": p["pot_bps"],
        "faucet_bps": p["faucet_bps"],
        "initial_holder": holder,
        "metadata": {"spec": "ft-1.0.0", "name": "Last Call", "symbol": "LAST", "decimals": 18},
    });
    let result = Contract::deploy(contract.clone())
        .use_code(wasm())
        .with_init_call("new", args)
        .expect("new args")
        .gas(NearGas::from_tgas(300))
        .with_signer(c.signer.clone())
        .send_to(&c.net)
        .await
        .expect("deploy");
    let tx = Tx(result.into_full().expect("full outcome")).expect_ok("deploy + new");
    assert_eq!(
        tx.events("nep141", "ft_mint").len(),
        1,
        "one ft_mint log (S3)"
    );
    Game {
        day_ms: num(&config["day_length_s"]) * 1000,
        client: c,
        config,
        contract,
        holder,
    }
}

/// One deployment of the contract.
#[derive(Clone)]
struct Game {
    client: Client,
    contract: AccountId,
    holder: AccountId,
    config: Value,
    day_ms: u64,
}

impl Game {
    fn cfg(&self, field: &str) -> u128 {
        let v = &self.config[field];
        v.as_u64().map(u128::from).unwrap_or_else(|| u(v))
    }

    async fn call_wait(
        &self,
        from: &AccountId,
        method: &str,
        args: Value,
        tgas: u64,
        deposit: u128,
        wait: TxExecutionStatus,
    ) -> Tx {
        self.client
            .send(
                from,
                &self.contract,
                vec![fc(method, args, tgas, deposit)],
                wait,
            )
            .await
    }

    async fn call(
        &self,
        from: &AccountId,
        method: &str,
        args: Value,
        tgas: u64,
        deposit: u128,
    ) -> Tx {
        self.call_wait(from, method, args, tgas, deposit, TxExecutionStatus::Final)
            .await
    }

    async fn batch(&self, from: &AccountId, actions: Vec<Action>) -> Tx {
        self.client
            .send(from, &self.contract, actions, TxExecutionStatus::Final)
            .await
    }

    async fn view(&self, method: &str, args: Value) -> Value {
        Contract(self.contract.clone())
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.client.net)
            .await
            .unwrap_or_else(|e| panic!("view {method}: {e}"))
            .data
    }

    async fn state(&self) -> Value {
        self.view("get_state", json!({})).await
    }

    async fn open_day(&self) -> Value {
        self.view("get_open_day", json!({})).await
    }

    async fn member(&self, account: &AccountId) -> Value {
        self.view("get_member", json!({ "account_id": account }))
            .await
    }

    async fn balance(&self, account: &AccountId) -> u128 {
        u(&self
            .view("ft_balance_of", json!({ "account_id": account }))
            .await)
    }

    /// `(today, ms_to_day_end)`.
    async fn clock(&self) -> (u32, u64) {
        let s = self.state().await;
        (num(&s["today"]) as u32, num(&s["ms_to_day_end"]))
    }

    /// Creates `<name>.sandbox` accounts (20 NEAR each), then registers them in the token and funds
    /// each with `FUND` LAST from the initial holder (one batch transaction per five players).
    async fn players(&self, names: &[&str]) -> Vec<AccountId> {
        let ids: Vec<AccountId> = names.iter().map(|n| self.client.sub(n)).collect();
        for id in &ids {
            self.client.create_account(id, 20).await;
        }
        let min = u(&self.view("storage_balance_bounds", json!({})).await["min"]);
        for chunk in ids.chunks(5) {
            let mut actions = Vec::new();
            for id in chunk {
                actions.push(fc(
                    "storage_deposit",
                    json!({"account_id": id, "registration_only": true}),
                    10,
                    min,
                ));
                actions.push(fc(
                    "ft_transfer",
                    json!({"receiver_id": id, "amount": FUND.to_string()}),
                    10,
                    ONE_YOCTO,
                ));
            }
            self.batch(&self.holder, actions)
                .await
                .expect_ok("register and fund players");
        }
        for id in &ids {
            assert_eq!(self.balance(id).await, FUND);
        }
        ids
    }

    async fn join(&self, who: &AccountId, key: Option<String>, deposit: u128) -> Tx {
        self.call(who, "join", json!({ "checkin_key": key }), 100, deposit)
            .await
    }

    /// I1, I2, I12 (partly), I13 (when nothing is pending) through the views. Returns `get_state`.
    async fn check_invariants(&self) -> Value {
        let s = self.state().await;
        let config = self.view("get_config", json!({})).await;
        let buckets = u(&s["pot"])
            + u(&s["reserved"])
            + u(&s["stake_pool"])
            + u(&s["faucet_left"])
            + u(&s["jackpot_pending"]);
        assert_eq!(self.balance(&self.contract).await, buckets, "I1");
        let supply = u(&self.view("ft_total_supply", json!({})).await);
        assert_eq!(supply, u(&s["total_supply"]));
        assert_eq!(
            supply,
            u(&config["initial_supply"]) - u(&s["total_burned"]),
            "I2"
        );
        assert!(u(&s["active_stake"]) <= u(&s["stake_pool"]), "I12");
        if s["pending_hero_days"].as_array().expect("array").is_empty() {
            assert_eq!(u(&s["jackpot_pending"]), 0, "I13");
        }
        s
    }

    /// I9 after a game call: `last_settled == today − 1`.
    async fn check_settled_through_yesterday(&self) {
        let s = self.state().await;
        let today = num(&s["today"]);
        let expected = if today == 0 {
            Value::Null
        } else {
            json!(today - 1)
        };
        assert_eq!(s["last_settled"], expected, "I9");
    }
}

/// The `hero` event of a transaction, from a receipt other than the main one (R10: the draw runs in
/// its own receipt, in a later block). Returns the event data and the receipt's gas.
async fn hero_of(g: &Game, tx: &Tx) -> Option<(Value, u64)> {
    let mut found = None;
    for o in tx.other_receipts_on(&g.contract) {
        let heroes = events_of(&o.logs, "lastcall", "hero");
        if heroes.is_empty() {
            continue;
        }
        assert_eq!(heroes.len(), 1);
        assert!(o.is_success());
        let main_height = g.client.block_height(tx.main().block_hash).await;
        let hero_height = g.client.block_height(o.block_hash).await;
        assert!(
            hero_height > main_height,
            "pick_hero runs in a later block than the settle"
        );
        assert!(found.is_none(), "one hero per transaction");
        found = Some((heroes[0]["data"].clone(), o.gas_burnt.as_gas()));
    }
    assert!(
        tx.main()
            .logs
            .iter()
            .all(|l| events_of([l], "lastcall", "hero").is_empty()),
        "no hero event in the settling receipt (R10)"
    );
    found
}

// ---- Tests ----

/// S18 int + C11 1, 2, 8, 9: deploy, `new` (demo set), delete every key of the contract account,
/// then the whole game path through views: join → warmup → check-in → settle by a stranger (with
/// the hero drawn in its own receipt) → claim → leave. Also: R9 storage of a join on real storage,
/// `#[private]` `pick_hero` from another account, the join surplus and the leave deposit refund.
#[tokio::test]
#[ignore = "sandbox"]
async fn int_base_path_keyless_contract() {
    let started = Instant::now();
    let node = Node::start().await;
    let g = node.deploy("lastcall", "demo", None).await;
    let c = &g.client;

    // C11 2 / I7: no keys on the contract account from here on.
    let keys = c.access_keys(&g.contract).await;
    assert!(!keys.is_empty());
    Account(g.contract.clone())
        .delete_keys(keys)
        .with_signer(c.signer.clone())
        .send_to(&c.net)
        .await
        .expect("delete keys")
        .assert_success();
    assert!(
        c.access_keys(&g.contract).await.is_empty(),
        "list keys is empty"
    );

    // S3 on chain: buckets and the holder's share.
    let supply: u128 = u(&params("demo")["total_supply"]);
    let s = g.check_invariants().await;
    assert_eq!(u(&s["pot"]), supply * 5000 / BPS);
    assert_eq!(u(&s["faucet_left"]), supply * 100 / BPS);
    assert_eq!(u(&s["total_supply"]), supply);
    assert_eq!(g.balance(&g.holder).await, supply - supply * 5100 / BPS);

    // A 64-character account id for the R9 worst case (MAX_MEMBER_BYTES: 64-byte id + key).
    let long_name = format!("r9-{}", "x".repeat(64 - 3 - 1 - c.root.as_str().len()));
    let ps = g.players(&["alice", "bob", "carol", &long_name]).await;
    let (alice, bob, carol, long) = (&ps[0], &ps[1], &ps[2], &ps[3]);
    assert_eq!(long.as_str().len(), 64);
    assert_eq!(
        g.balance(&g.holder).await,
        supply - supply * 5100 / BPS - 4 * FUND
    );
    let stranger = c.sub("stranger");
    c.create_account(&stranger, 10).await;

    let stake = g.cfg("join_stake");
    let d0 = node.fresh_day(&g, 40_000).await;
    // Settle whatever is pending, so that the measured join writes nothing but its own records (an
    // auto-settle adds history slots).
    g.call(&stranger, "settle", json!({}), 300, 0)
        .await
        .expect_ok("settle before the joins");

    // R9: the first join of the day (new `maturing` entry), 64-byte id, a check-in key, and a
    // surplus of one more deposit that must come back.
    let usage0 = c.storage_usage(&g.contract).await;
    let near0 = c.near_balance(long).await;
    let tx = g
        .join(
            long,
            Some(public_key_str(&checkin_key(9))),
            2 * MEMBER_DEPOSIT,
        )
        .await
        .expect_ok("join (64-char id, key, surplus)");
    let grown_long = c.storage_usage(&g.contract).await - usage0;
    assert!(
        tx.events("lastcall", "days_settled").is_empty(),
        "the measured join also settled days (the game clock moved); rerun"
    );
    let spent = near0 - c.near_balance(long).await;
    assert!(
        (MEMBER_DEPOSIT..MEMBER_DEPOSIT + MEMBER_DEPOSIT / 2).contains(&spent),
        "the join surplus is refunded: spent {spent}"
    );
    assert_eq!(tx.events("lastcall", "join").len(), 1);
    println!(
        "C11 R9: join of a 64-char id with a check-in key (first of the day) grew the contract's \
         storage_usage by {grown_long} bytes ({} yocto ≤ deposit {MEMBER_DEPOSIT}); gas {:.2} Tgas",
        u128::from(grown_long) * BYTE_COST,
        tgas(tx.gas())
    );
    assert!(grown_long <= MAX_MEMBER_BYTES, "R9: ≤ MAX_MEMBER_BYTES");

    let usage1 = c.storage_usage(&g.contract).await;
    g.join(alice, None, MEMBER_DEPOSIT)
        .await
        .expect_ok("join alice");
    let grown_short = c.storage_usage(&g.contract).await - usage1;
    println!(
        "C11 R9: join of a {}-char id without a key (maturing entry exists) grew storage_usage by \
         {grown_short} bytes",
        alice.as_str().len()
    );
    for p in [bob, carol] {
        g.join(p, None, MEMBER_DEPOSIT).await.expect_ok("join");
    }
    for p in &ps {
        let m = g.member(p).await;
        assert_eq!(num(&m["join_day"]), u64::from(d0), "all joined on day {d0}");
        assert_eq!(num(&m["activation_day"]), u64::from(d0 + 1));
        assert_eq!(u(&m["stake"]), stake);
        assert_eq!(u(&m["storage_deposit"]), MEMBER_DEPOSIT);
        assert_eq!(m["is_active"], false);
        assert_eq!(g.balance(p).await, FUND - stake);
    }
    assert!(g.member(long).await["checkin_key"].is_string());
    let s = g.check_invariants().await;
    assert_eq!(u(&s["stake_pool"]), 4 * stake);
    assert_eq!(num(&s["members_total"]), 4);
    assert_eq!(num(&s["active_count"]), 0);

    // Day d0 + 1: three of four active members check in, each in its own block (R5).
    node.goto_day(&g, d0 + 1).await;
    for (i, p) in [alice, bob, carol].into_iter().enumerate() {
        let tx = g
            .call(p, "check_in", json!({}), 100, 0)
            .await
            .expect_ok("check_in");
        let r = tx.value();
        assert_eq!(
            r,
            json!({"day": d0 + 1, "n": i + 1, "goal": 3, "in_closers": true})
        );
        let ev = tx.events("lastcall", "check_in");
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["data"]["via"], "direct");
        g.check_settled_through_yesterday().await;
    }
    let open = g.open_day().await;
    assert_eq!(open["day"], json!(d0 + 1));
    assert_eq!(open["goal"], json!(3));
    assert_eq!(open["count"], json!(3));
    assert_eq!(open["active"], json!(4));
    assert_eq!(open["closers"], json!([alice, bob, carol]));
    assert_eq!(g.member(alice).await["checked_in_today"], true);
    let s = g.check_invariants().await;
    let pot = u(&s["pot"]);

    // Day d0 + 2: settle by an account that is neither a member nor registered in the token.
    node.goto_day(&g, d0 + 2).await;
    let tx = g
        .call(&stranger, "settle", json!({}), 100, 0)
        .await
        .expect_ok("settle by a stranger");
    assert_eq!(tx.value(), json!(1));
    let ps_ = per_share(
        pot,
        g.cfg("emit_bps"),
        1,
        g.cfg("streak_cap"),
        g.cfg("streak_step_bps"),
        3,
        g.cfg("jackpot_mult"),
    );
    let jackpot = ps_ * g.cfg("jackpot_mult");
    assert!(ps_ > 0);
    let runs = &tx.events("lastcall", "days_settled")[0]["data"]["runs"];
    assert_eq!(
        runs,
        &json!([{
            "from_day": d0 + 1, "to_day": d0 + 1, "outcome": "Success", "goal": 3, "count": 3,
            "streak_after": 1, "per_share": ps_.to_string(), "jackpot": jackpot.to_string(),
            "pot_burned": "0", "stake_slashed": "0", "pot_after": (pot - 13 * ps_).to_string(),
        }])
    );
    let (hero, hero_gas) = hero_of(&g, &tx).await.expect("hero receipt");
    println!(
        "C11 gas: settle(1 successful day) {:.2} Tgas; pick_hero receipt {:.2} Tgas (PICK_HERO_GAS {} Tgas)",
        tgas(tx.gas()),
        tgas(hero_gas),
        PICK_HERO_GAS.as_tgas()
    );
    assert_eq!(hero["day"], json!(d0 + 1));
    assert_eq!(hero["jackpot"], json!(jackpot.to_string()));
    assert_eq!(hero["paid"], true);
    let hero_id: AccountId = hero["account_id"].as_str().unwrap().parse().unwrap();
    assert!([alice, bob, carol].contains(&&hero_id));
    for p in [alice, bob, carol] {
        let expected = FUND - stake + if *p == hero_id { jackpot } else { 0 };
        assert_eq!(g.balance(p).await, expected);
        assert_eq!(u(&g.member(p).await["pending_claimable"]), ps_);
    }
    assert_eq!(g.member(&hero_id).await["hero_count"], json!(1));
    let s = g.check_invariants().await;
    assert_eq!(u(&s["pot"]), pot - 13 * ps_);
    assert_eq!(u(&s["reserved"]), 3 * ps_);
    assert_eq!(u(&s["total_rewarded"]), 3 * ps_);
    assert_eq!(u(&s["total_jackpots"]), jackpot);
    assert_eq!(u(&s["jackpot_pending"]), 0);
    assert_eq!(s["pending_hero_days"], json!([]));
    assert_eq!(s["streak"], json!(1));
    let history = g.view("get_history", json!({"limit": 1})).await;
    assert_eq!(history[0]["day"], json!(d0 + 1));
    assert_eq!(history[0]["hero"], json!(hero_id));

    // C11 8: `#[private]` is enforced by the wasm wrapper.
    for who in [&stranger, alice] {
        g.call(who, "pick_hero", json!({"day": d0 + 1}), 30, 0)
            .await
            .expect_err(
                "pick_hero from another account",
                "Method pick_hero is private",
            );
    }

    // claim (S13): the share of day d0 + 1.
    let tx = g
        .call(alice, "claim", json!({}), 100, ONE_YOCTO)
        .await
        .expect_ok("claim");
    assert_eq!(tx.value(), json!(ps_.to_string()));
    assert_eq!(
        tx.events("lastcall", "claim")[0]["data"]["amount"],
        json!(ps_.to_string())
    );
    let alice_balance = FUND - stake + ps_ + if *alice == hero_id { jackpot } else { 0 };
    assert_eq!(g.balance(alice).await, alice_balance);
    g.call(long, "claim", json!({}), 100, ONE_YOCTO)
        .await
        .expect_err("claim without a share", "ERR_NOTHING_TO_CLAIM");
    let s = g.check_invariants().await;
    assert_eq!(u(&s["reserved"]), 2 * ps_);

    // leave (S10): bob did not check in today → fee 10% burned; his share is paid out; the NEAR
    // storage deposit comes back.
    let bob_before = g.balance(bob).await;
    let near_before = c.near_balance(bob).await;
    let tx = g
        .call(bob, "leave", json!({}), 100, ONE_YOCTO)
        .await
        .expect_ok("leave");
    let fee = stake * g.cfg("slash_bps") / BPS;
    assert_eq!(tx.value(), json!((stake - fee).to_string()));
    let burn = tx.events("nep141", "ft_burn");
    assert_eq!(burn.len(), 1);
    assert_eq!(burn[0]["data"][0]["amount"], json!(fee.to_string()));
    let leave = &tx.events("lastcall", "leave")[0]["data"];
    assert_eq!(leave["returned"], json!((stake - fee).to_string()));
    assert_eq!(leave["fee_burned"], json!(fee.to_string()));
    assert_eq!(g.balance(bob).await, bob_before + stake - fee + ps_);
    let near_gain = c.near_balance(bob).await - near_before;
    assert!(
        near_gain > MEMBER_DEPOSIT * 9 / 10,
        "storage deposit refunded: +{near_gain}"
    );
    assert_eq!(g.member(bob).await, Value::Null);
    let s = g.check_invariants().await;
    assert_eq!(num(&s["members_total"]), 3);
    assert_eq!(num(&s["active_count"]), 3);
    assert_eq!(u(&s["stake_pool"]), 3 * stake);
    assert_eq!(u(&s["total_burned"]), fee);
    assert_eq!(u(&s["total_supply"]), supply - fee);
    assert_eq!(u(&s["reserved"]), ps_);
    g.check_settled_through_yesterday().await;

    assert!(c.access_keys(&g.contract).await.is_empty(), "still no keys");
    println!(
        "C11 int_base_path_keyless_contract: {:.0} s",
        started.elapsed().as_secs_f64()
    );
}

/// `get_state` / `get_open_day` without the fields that move with the clock.
fn game_fields(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        for k in ["today", "pending_days", "ms_to_day_end", "stale"] {
            o.remove(k);
        }
    }
    v
}

/// S18 10, 25, 27 + C11 3, 4, 7 on a deployment with 10-second days (the S3 minimum): 600 days of
/// backlog in which three active members never check in, so every day fails (pot burn, aggregate
/// slash, a failed bit) — the expensive case for `settle`.
#[tokio::test]
#[ignore = "sandbox"]
async fn t10_t25_t27_backlog_gas_logs_and_transfers() {
    let started = Instant::now();
    let node = Node::start().await;
    let g = node.deploy("lastcall", "demo", Some(10)).await;
    let c = &g.client;
    let ps = g.players(&["alice", "bob", "carol", "sink"]).await;
    let (alice, sink) = (&ps[0], &ps[3]);
    let stranger = c.sub("stranger");
    c.create_account(&stranger, 10).await;
    for p in &ps[..3] {
        g.join(p, None, MEMBER_DEPOSIT).await.expect_ok("join");
    }
    let mut act = 0;
    for p in &ps[..3] {
        act = act.max(num(&g.member(p).await["activation_day"]) as u32);
    }
    // Settle up to the activation day so that the backlog starts with all three members active.
    node.goto_day(&g, act).await;
    g.call(&stranger, "settle", json!({}), 300, 0)
        .await
        .expect_ok("settle up to the activation day");
    let base = g.check_invariants().await;
    let a = num(&base["last_settled"]) as u32 + 1;
    assert_eq!(a, act);
    let open = g.open_day().await;
    assert_eq!(
        (
            open["goal"].clone(),
            open["active"].clone(),
            open["count"].clone()
        ),
        (json!(3), json!(3), json!(0))
    );

    // A node pause only makes the backlog longer, which changes nothing below.
    let t = Instant::now();
    let today = node.goto_day_at_least(&g, a + 600).await;
    println!(
        "C11 time: fast-forward over {} ten-second days: {:.0} s",
        today - a,
        t.elapsed().as_secs_f64()
    );
    assert!(num(&g.state().await["pending_days"]) >= 600);

    // t27: ERR_BACKLOG before any work — cheap, nothing changes.
    let before = (
        game_fields(&g.state().await),
        game_fields(&g.open_day().await),
    );
    let tx = g.call(alice, "check_in", json!({}), 300, 0).await;
    tx.expect_err("check_in with 600 pending days", "ERR_BACKLOG");
    let backlog_gas = tx.gas();
    let tx = g.call(alice, "leave", json!({}), 300, ONE_YOCTO).await;
    tx.expect_err("leave with 600 pending days", "ERR_BACKLOG");
    println!(
        "C11 gas t27: ERR_BACKLOG check_in {:.2} Tgas, leave {:.2} Tgas (300 Tgas attached)",
        tgas(backlog_gas),
        tgas(tx.gas())
    );
    assert!(
        backlog_gas < 5 * TGAS && tx.gas() < 5 * TGAS,
        "ERR_BACKLOG is cheap"
    );
    let after = (
        game_fields(&g.state().await),
        game_fields(&g.open_day().await),
    );
    assert_eq!(after, before, "ERR_BACKLOG changed nothing");

    // t25: NEP-141 never settles and never gives ERR_BACKLOG.
    let amount: u128 = 1_000_000_000_000_000_000_000;
    let (h0, a0) = (g.balance(&g.holder).await, g.balance(alice).await);
    g.call(
        &g.holder,
        "ft_transfer",
        json!({"receiver_id": alice, "amount": amount.to_string()}),
        30,
        ONE_YOCTO,
    )
    .await
    .expect_ok("ft_transfer with a backlog");
    assert_eq!(g.balance(&g.holder).await, h0 - amount);
    assert_eq!(g.balance(alice).await, a0 + amount);
    // ft_transfer_call to an account without a contract: ft_on_transfer fails, ft_resolve_transfer
    // returns everything to the sender.
    let s0 = g.check_invariants().await;
    let (h1, k1) = (g.balance(&g.holder).await, g.balance(sink).await);
    let tx = g
        .call(
            &g.holder,
            "ft_transfer_call",
            json!({"receiver_id": sink, "amount": amount.to_string(), "msg": ""}),
            100,
            ONE_YOCTO,
        )
        .await
        .expect_ok("ft_transfer_call with a backlog");
    assert_eq!(
        tx.value(),
        json!("0"),
        "used amount 0: the whole amount came back"
    );
    let failures = tx.0.receipt_failures();
    assert_eq!(failures.len(), 1, "only ft_on_transfer failed");
    assert_eq!(failures[0].executor_id, *sink);
    let failure = format!("{:?}", failures[0].clone().into_result().err());
    let transfers = tx.events("nep141", "ft_transfer");
    assert_eq!(transfers.len(), 2);
    assert_eq!(transfers[1]["data"][0]["memo"], "refund");
    assert_eq!(transfers[1]["data"][0]["amount"], json!(amount.to_string()));
    println!("C11 t25: ft_on_transfer on an account without code failed with {failure}");
    assert_eq!(g.balance(&g.holder).await, h1);
    assert_eq!(g.balance(sink).await, k1);
    let s1 = g.check_invariants().await;
    assert_eq!(
        game_fields(&s1),
        game_fields(&s0),
        "no settle, total_supply and total_burned intact"
    );

    // t10: one settle(None) settles MAX_SETTLE_DAYS failed days. Model of S8 Fail with no
    // check-ins and no exits: pot −= pot × burn_bps / B; slash = active × slash_bps / B.
    let (burn_bps, slash_bps) = (g.cfg("burn_bps"), g.cfg("slash_bps"));
    let (mut pot, mut active, mut pool) =
        (u(&s1["pot"]), u(&s1["active_stake"]), u(&s1["stake_pool"]));
    let (mut pot_burned, mut slashed) = (0u128, 0u128);
    for _ in 0..MAX_SETTLE_DAYS {
        let pb = pot * burn_bps / BPS;
        pot -= pb;
        let sl = (active * slash_bps / BPS).min(active);
        active -= sl;
        pool -= sl;
        pot_burned += pb;
        slashed += sl;
    }
    let tx = g
        .call(&stranger, "settle", json!({}), 300, 0)
        .await
        .expect_ok("settle(None) over 600 pending days");
    assert_eq!(tx.value(), json!(MAX_SETTLE_DAYS));
    let logs = &tx.main().logs;
    let bytes: usize = logs.iter().map(String::len).sum();
    println!(
        "C11 gas t10: settle(None) of {MAX_SETTLE_DAYS} failed days {:.2} Tgas; {} logs, {bytes} bytes",
        tgas(tx.gas()),
        logs.len()
    );
    assert!(tx.gas() < 300 * TGAS);
    assert!(bytes < 16_384, "logs fit the 16 KiB receipt limit");
    assert_eq!(logs.len(), 2, "ft_burn + days_settled");
    let burns = events_of(logs, "nep141", "ft_burn");
    assert_eq!(burns.len(), 1);
    assert_eq!(
        burns[0]["data"],
        json!([{
            "owner_id": g.contract,
            "amount": (pot_burned + slashed).to_string(),
            "memo": format!("days {a}..{}", a + MAX_SETTLE_DAYS - 1),
        }])
    );
    let settled = events_of(logs, "lastcall", "days_settled");
    assert_eq!(settled.len(), 1);
    assert_eq!(
        settled[0]["data"]["runs"],
        json!([{
            "from_day": a, "to_day": a + MAX_SETTLE_DAYS - 1, "outcome": "Fail", "goal": 3,
            "count": 0, "streak_after": 0, "per_share": "0", "jackpot": "0",
            "pot_burned": pot_burned.to_string(), "stake_slashed": slashed.to_string(),
            "pot_after": pot.to_string(),
        }])
    );
    let s = g.check_invariants().await;
    assert_eq!(s["last_settled"], json!(a + MAX_SETTLE_DAYS - 1));
    assert_eq!(u(&s["pot"]), pot);
    assert_eq!(u(&s["active_stake"]), active);
    assert_eq!(u(&s["stake_pool"]), pool);
    assert_eq!(
        u(&s["total_burned"]),
        u(&s1["total_burned"]) + pot_burned + slashed
    );
    let history = g.view("get_history", json!({"limit": 100})).await;
    let history = history.as_array().expect("history");
    assert_eq!(history.len(), 64, "the ring keeps the last 64 days");
    assert_eq!(history[0]["day"], json!(a + MAX_SETTLE_DAYS - 1));
    assert_eq!(history[63]["day"], json!(a + MAX_SETTLE_DAYS - 64));

    // The rest of the backlog.
    let tx = g
        .call(&stranger, "settle", json!({}), 300, 0)
        .await
        .expect_ok("second settle(None)");
    let rest = num(&tx.value());
    println!(
        "C11 gas t10: second settle(None) of {rest} days {:.2} Tgas",
        tgas(tx.gas())
    );
    assert!(rest >= 100);
    g.check_settled_through_yesterday().await;

    // A game call that auto-settles exactly AUTO_SETTLE_CAP days (all failed), plus a resolve of
    // alice over every failed day since her activation. A node pause between the jump and the call
    // makes the backlog longer than the cap (ERR_BACKLOG): then settle and try again.
    let mut attempt = 0;
    let (tx, next) = loop {
        attempt += 1;
        assert!(attempt <= 3, "node pauses spoiled three attempts");
        let next = num(&g.state().await["last_settled"]) as u32 + 1;
        if !node.try_goto_day(&g, next + AUTO_SETTLE_CAP).await {
            g.call(&stranger, "settle", json!({}), 300, 0)
                .await
                .expect_ok("settle");
            continue;
        }
        let tx = g.call(alice, "check_in", json!({}), 300, 0).await;
        if tx.ok() {
            break (tx, next);
        }
        tx.expect_err("check_in with AUTO_SETTLE_CAP pending days", "ERR_BACKLOG");
        println!("C11 note: a node pause pushed the backlog over the cap; settling and retrying");
        g.call(&stranger, "settle", json!({}), 300, 0)
            .await
            .expect_ok("settle");
    };
    let runs = tx.events("lastcall", "days_settled")[0]["data"]["runs"].clone();
    let runs = runs.as_array().expect("runs");
    assert_eq!(runs[0]["from_day"], json!(next));
    assert_eq!(
        runs[runs.len() - 1]["to_day"],
        json!(next + AUTO_SETTLE_CAP - 1)
    );
    assert_eq!(tx.value()["day"], json!(next + AUTO_SETTLE_CAP));
    println!(
        "C11 gas: check_in with auto-settle of {AUTO_SETTLE_CAP} failed days and a resolve over {} \
         days {:.2} Tgas",
        next + AUTO_SETTLE_CAP - act,
        tgas(tx.gas())
    );
    assert!(tx.gas() < 300 * TGAS);
    g.check_invariants().await;
    g.check_settled_through_yesterday().await;
    println!(
        "C11 t10_t25_t27_backlog_gas_logs_and_transfers: {:.0} s",
        started.elapsed().as_secs_f64()
    );
}

/// The `pick_hero` function calls (receipt id, prepaid gas) among the receipts a receipt created,
/// read through `EXPERIMENTAL_receipt`; empty if the node does not serve it.
async fn pick_hero_prepaid(c: &Client, created: &[CryptoHash]) -> Vec<(CryptoHash, u64)> {
    let mut out = Vec::new();
    for id in created {
        let Some(receipt) = c.receipt_json(*id).await else {
            continue;
        };
        let actions = &receipt["receipt"]["Action"]["actions"];
        for action in actions.as_array().into_iter().flatten() {
            let call = &action["FunctionCall"];
            if call["method_name"] == "pick_hero" {
                // The RPC types serialize gas as a decimal string.
                let gas = call["gas"]
                    .as_u64()
                    .or_else(|| call["gas"].as_str().and_then(|s| s.parse().ok()))
                    .unwrap_or_else(|| panic!("gas of {call}"));
                out.push((*id, gas));
            }
        }
    }
    out
}

/// S18 28 + C11 5 and 3 (pick_hero, retry_pick_hero) + t31: the grinding batch
/// `[settle(None), ft_transfer(alt, balance + jackpot)]` sent by a closer always fails and rolls the
/// settle back; a plain settle then passes and the hero is drawn and paid in a separate receipt.
#[tokio::test]
#[ignore = "sandbox"]
async fn t28_grinding_batch_reverts_and_hero_is_a_separate_receipt() {
    let started = Instant::now();
    let node = Node::start().await;
    let g = node.deploy("lastcall", "demo", None).await;
    let c = &g.client;
    let ps = g.players(&["alice", "bob", "carol", "alt"]).await;
    let (members, alice, bob, alt) = (&ps[..3], &ps[0], &ps[1], &ps[3]);
    let stranger = c.sub("stranger");
    c.create_account(&stranger, 10).await;
    let stake = g.cfg("join_stake");
    let (emit, cap, step, mult) = (
        g.cfg("emit_bps"),
        g.cfg("streak_cap"),
        g.cfg("streak_step_bps"),
        g.cfg("jackpot_mult"),
    );

    let d0 = node.fresh_day(&g, 30_000).await;
    for p in members {
        g.join(p, None, MEMBER_DEPOSIT).await.expect_ok("join");
    }
    node.goto_day(&g, d0 + 1).await;
    for p in members {
        g.call(p, "check_in", json!({}), 100, 0)
            .await
            .expect_ok("check_in");
    }
    assert_eq!(g.open_day().await["closers"], json!(members));

    node.goto_day(&g, d0 + 2).await;
    let s0 = g.check_invariants().await;
    let jackpot = per_share(u(&s0["pot"]), emit, 1, cap, step, 3, mult) * mult;
    let balance = g.balance(alice).await;
    assert_eq!(balance, FUND - stake);

    // t31: too little gas left for the pick_hero promise → ERR_LOW_GAS before any work.
    let tx = g.call(&stranger, "settle", json!({}), 14, 0).await;
    tx.expect_err("settle with 14 Tgas over a successful day", "ERR_LOW_GAS");
    assert_eq!(game_fields(&g.state().await), game_fields(&s0));

    // The grinding batch: whoever the hero is, the jackpot is not on alice's balance inside this
    // receipt, so the transfer of balance + jackpot always fails and takes the settle with it.
    for attempt in 1..=3 {
        let tx = g
            .batch(
                alice,
                vec![
                    fc("settle", json!({}), 100, 0),
                    fc(
                        "ft_transfer",
                        json!({"receiver_id": alt, "amount": (balance + jackpot).to_string()}),
                        30,
                        ONE_YOCTO,
                    ),
                ],
            )
            .await;
        tx.expect_err("grinding batch", "The account doesn't have enough balance");
        if attempt == 1 {
            println!("C11 t28: grinding batch failure: {}", tx.failure());
        }
        assert!(
            tx.failure().contains("Some(1)"),
            "the second action (ft_transfer) failed"
        );
        assert!(
            tx.other_receipts_on(&g.contract).is_empty(),
            "a failed receipt creates no pick_hero"
        );
        assert_eq!(
            game_fields(&g.state().await),
            game_fields(&s0),
            "attempt {attempt}: the settle was rolled back (last_settled, pot, no pending hero)"
        );
        assert_eq!(g.balance(alice).await, balance);
        assert_eq!(g.balance(alt).await, FUND);
    }

    // A plain settle passes; the hero is drawn and paid in its own receipt.
    let tx = g
        .call(bob, "settle", json!({}), 100, 0)
        .await
        .expect_ok("plain settle");
    assert_eq!(tx.value(), json!(1));
    let (hero, hero_gas) = hero_of(&g, &tx).await.expect("hero receipt");
    assert_eq!(hero["day"], json!(d0 + 1));
    assert_eq!(hero["jackpot"], json!(jackpot.to_string()));
    assert_eq!(hero["paid"], true);
    let hero_id: AccountId = hero["account_id"].as_str().unwrap().parse().unwrap();
    assert!(members.contains(&hero_id));
    assert_eq!(g.balance(&hero_id).await, FUND - stake + jackpot);
    let prepaid = pick_hero_prepaid(c, &tx.main().receipt_ids).await;
    println!(
        "C11 gas: pick_hero receipt {:.2} Tgas burnt (hero {hero_id}); prepaid of the pick_hero \
         receipt (static {} Tgas + unused gas of a 100 Tgas settle, weight 1): {:?}",
        tgas(hero_gas),
        PICK_HERO_GAS.as_tgas(),
        prepaid
            .iter()
            .map(|(_, gas)| format!("{:.2} Tgas", tgas(*gas)))
            .collect::<Vec<_>>()
    );
    let s = g.check_invariants().await;
    assert_eq!(u(&s["total_jackpots"]), jackpot);
    assert_eq!(s["streak"], json!(1));

    // retry_pick_hero has something to do only while a jackpot is pending, i.e. inside the settling
    // receipt. A batch [settle(None), retry_pick_hero(day)] schedules a second pick_hero for the same
    // day with a large prepaid gas (unused-gas weight 1); the second draw is a no-op.
    for p in members {
        g.call(p, "check_in", json!({}), 100, 0)
            .await
            .expect_ok("check_in");
    }
    node.goto_day(&g, d0 + 3).await;
    let pot = u(&g.state().await["pot"]);
    let jackpot2 = per_share(pot, emit, 2, cap, step, 3, mult) * mult;
    let tx = g
        .batch(
            &stranger,
            vec![
                fc("settle", json!({}), 40, 0),
                fc("retry_pick_hero", json!({"day": d0 + 2}), 250, 0),
            ],
        )
        .await
        .expect_ok("settle + retry_pick_hero");
    let picks = tx.other_receipts_on(&g.contract);
    assert_eq!(picks.len(), 2, "two pick_hero receipts");
    assert!(picks.iter().all(|o| o.is_success()));
    let drawn: Vec<_> = picks
        .iter()
        .filter(|o| !events_of(&o.logs, "lastcall", "hero").is_empty())
        .collect();
    assert_eq!(drawn.len(), 1, "the jackpot is drawn once");
    let noop = picks
        .iter()
        .find(|o| o.logs.is_empty())
        .expect("the no-op draw");
    let prepaid = pick_hero_prepaid(c, &tx.main().receipt_ids).await;
    println!(
        "C11 gas: settle + retry_pick_hero main receipt {:.2} Tgas; pick_hero that drew {:.2} Tgas, \
         no-op pick_hero {:.2} Tgas; prepaid of the two pick_hero receipts (settle 40 Tgas, \
         retry 250 Tgas attached): {:?}",
        tgas(tx.gas()),
        tgas(drawn[0].gas_burnt.as_gas()),
        tgas(noop.gas_burnt.as_gas()),
        prepaid
            .iter()
            .map(|(_, gas)| format!("{:.2} Tgas", tgas(*gas)))
            .collect::<Vec<_>>()
    );
    if prepaid.len() == 2 {
        assert!(
            prepaid[1].1 > 200 * TGAS,
            "the retry's pick_hero got the unused gas (weight 1)"
        );
    }
    let s = g.check_invariants().await;
    assert_eq!(u(&s["total_jackpots"]), jackpot + jackpot2);
    assert_eq!(s["pending_hero_days"], json!([]));
    g.call(&stranger, "retry_pick_hero", json!({"day": d0 + 2}), 300, 0)
        .await
        .expect_err("retry for a drawn day", "ERR_NO_PENDING_HERO");
    println!(
        "C11 t28_grinding_batch_reverts_and_hero_is_a_separate_receipt: {:.0} s",
        started.elapsed().as_secs_f64()
    );
}

/// R5 on a real chain (S7, S12, S18 11–12): one transaction of five `check_in_signed` actions is one
/// receipt at one block height, so it adds exactly one closer although all five check-ins are within
/// the goal. Signatures: near-api's NEP-413 hash, ed25519-dalek keys.
#[tokio::test]
#[ignore = "sandbox"]
async fn r5_five_signed_check_ins_in_one_transaction_add_one_closer() {
    let started = Instant::now();
    let node = Node::start().await;
    let g = node.deploy("lastcall", "demo", None).await;
    let c = &g.client;
    // p1, the only closer and so the hero, has a 64-character id: the worst case for `pick_hero`
    // (a member record and a token balance under the longest key).
    let p1 = format!("p1-{}", "x".repeat(64 - 3 - 1 - c.root.as_str().len()));
    let ps = g
        .players(&[&p1, "p2", "p3", "p4", "p5", "p6", "p7", "p8"])
        .await;
    assert_eq!(ps[0].as_str().len(), 64);
    let relayer = c.sub("relayer");
    c.create_account(&relayer, 10).await;

    let d0 = node.fresh_day(&g, 40_000).await;
    for (i, p) in ps.iter().enumerate() {
        let key = (i < 5).then(|| public_key_str(&checkin_key(i as u8)));
        g.join(p, key, MEMBER_DEPOSIT).await.expect_ok("join");
    }
    for p in &ps {
        assert_eq!(num(&g.member(p).await["join_day"]), u64::from(d0));
    }

    let d1 = d0 + 1;
    node.goto_day(&g, d1).await;
    let actions = (0..5)
        .map(|i| {
            fc(
                "check_in_signed",
                signed_check_in_args(&checkin_key(i as u8), &ps[i], d1, &g.contract, 7),
                30,
                0,
            )
        })
        .collect();
    let tx = g
        .batch(&relayer, actions)
        .await
        .expect_ok("five signed check-ins in one transaction");
    let events = events_of(&tx.main().logs, "lastcall", "check_in");
    assert_eq!(events.len(), 5, "all five in one receipt");
    for (i, e) in events.iter().enumerate() {
        assert_eq!(
            e["data"],
            json!({"account_id": ps[i], "day": d1, "n": i + 1, "goal": 5, "in_closers": i == 0, "via": "signed"})
        );
    }
    println!(
        "C11 gas: five check_in_signed in one receipt {:.2} Tgas",
        tgas(tx.gas())
    );
    let open = g.open_day().await;
    assert_eq!(open["goal"], json!(5));
    assert_eq!(open["active"], json!(8));
    assert_eq!(open["count"], json!(5));
    assert_eq!(
        open["closers"],
        json!([ps[0]]),
        "exactly one closer from the batch"
    );

    // A later block, past the goal: no candidate.
    let r = g
        .call(&ps[5], "check_in", json!({}), 100, 0)
        .await
        .expect_ok("check_in")
        .value();
    assert_eq!(
        r,
        json!({"day": d1, "n": 6, "goal": 5, "in_closers": false})
    );
    assert_eq!(g.open_day().await["closers"], json!([ps[0]]));

    // The only closer is the hero of the day.
    node.goto_day(&g, d1 + 1).await;
    let tx = g
        .call(&relayer, "settle", json!({}), 100, 0)
        .await
        .expect_ok("settle");
    let (hero, hero_gas) = hero_of(&g, &tx).await.expect("hero receipt");
    assert_eq!(hero["account_id"], json!(ps[0]));
    assert_eq!(g.member(&ps[0]).await["hero_count"], json!(1));
    println!(
        "C11 gas: pick_hero receipt with a 64-char member hero {:.2} Tgas (PICK_HERO_GAS {} Tgas)",
        tgas(hero_gas),
        PICK_HERO_GAS.as_tgas()
    );
    g.check_invariants().await;
    println!(
        "C11 r5_five_signed_check_ins_in_one_transaction_add_one_closer: {:.0} s",
        started.elapsed().as_secs_f64()
    );
}

/// S18 28 (distribution) + C11 5: the hero's slot among the closers over N draws
/// (`LAST_CALL_HERO_DAYS`, default 200), spread over `LAST_CALL_HERO_INSTANCES` (default 4)
/// deployments on one node that play the same days concurrently. In every deployment three members
/// check in every day, each in its own block, so every five has three slots; the next day's first
/// check-in settles the day and the hero is drawn in its own receipt. A day whose check-ins did not
/// all land inside it (a node pause) is not counted.
#[tokio::test]
#[ignore = "sandbox"]
async fn t28_hero_slots_are_uniform() {
    let env_u32 = |name: &str, default: u32| {
        std::env::var(name)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(default)
    };
    let total = env_u32("LAST_CALL_HERO_DAYS", 200);
    let instances = env_u32("LAST_CALL_HERO_INSTANCES", 4).max(1) as usize;
    let started = Instant::now();
    let node = Node::start().await;
    let names: Vec<String> = (0..instances).map(|k| format!("lc{k}")).collect();
    let games = node.deploy_many(&names, "demo", None).await;
    let mut players = Vec::new();
    for (k, g) in games.iter().enumerate() {
        let ps = g
            .players(&[&format!("h{k}a"), &format!("h{k}b"), &format!("h{k}c")])
            .await;
        for p in &ps {
            g.join(p, None, MEMBER_DEPOSIT).await.expect_ok("join");
        }
        players.push(ps);
    }
    // Days are counted from each deployment's launch; move by the latest launch so that every
    // deployment is inside the wanted day.
    let mut act = 0;
    let mut latest = (0u64, 0usize);
    for (k, g) in games.iter().enumerate() {
        for p in &players[k] {
            act = act.max(num(&g.member(p).await["activation_day"]) as u32);
        }
        let launch: u64 = g.view("get_config", json!({})).await["launch_ns"]
            .as_str()
            .expect("launch_ns")
            .parse()
            .expect("u64");
        latest = latest.max((launch, k));
    }
    let lead = &games[latest.1];
    println!(
        "C11 t28: {instances} deployments, setup {:.0} s",
        started.elapsed().as_secs_f64()
    );

    let mut slots = [0u32; 3];
    let mut skipped = 0u32;
    let mut previous: Vec<Option<(u32, Vec<Value>)>> = vec![None; instances];
    let mut d = act;
    while slots.iter().sum::<u32>() < total {
        assert!(d < act + 3 * total, "too many lost days");
        // After a node pause the clock may be past `d`: then play today. The pending heroes are
        // still drawn by the first check-in of whatever day comes next.
        d = node.goto_day_at_least(lead, d).await;
        let day_started = Instant::now();
        let mut complete = vec![true; instances];
        for i in 0..3 {
            let handles: Vec<_> = games
                .iter()
                .zip(&players)
                .map(|(g, ps)| {
                    let (g, p) = (g.clone(), ps[i].clone());
                    tokio::spawn(async move {
                        g.call_wait(
                            &p,
                            "check_in",
                            json!({}),
                            100,
                            0,
                            TxExecutionStatus::ExecutedOptimistic,
                        )
                        .await
                    })
                })
                .collect();
            for (k, h) in handles.into_iter().enumerate() {
                let tx = h.await.expect("check_in task").expect_ok("check_in");
                if tx.value()["day"] != json!(d) {
                    complete[k] = false;
                }
                if i > 0 {
                    continue;
                }
                let heroes = tx.events("lastcall", "hero");
                match previous[k].take() {
                    Some((day, closers))
                        if heroes.len() == 1 && heroes[0]["data"]["day"] == json!(day) =>
                    {
                        let hero = &heroes[0]["data"];
                        assert_eq!(hero["paid"], true);
                        let slot = closers
                            .iter()
                            .position(|c| *c == hero["account_id"])
                            .expect("the hero is a closer");
                        if slots.iter().sum::<u32>() < total {
                            slots[slot] += 1;
                        }
                    }
                    Some((day, _)) => {
                        println!("C11 t28: no hero for day {day} of lc{k} in the next check-in");
                        skipped += 1;
                    }
                    None => {}
                }
            }
        }
        for (k, g) in games.iter().enumerate() {
            let open = g.open_day().await;
            let closers = open["closers"].as_array().expect("closers").clone();
            if complete[k] && open["day"] == json!(d) && closers.len() == 3 {
                previous[k] = Some((d, closers));
            } else {
                println!(
                    "C11 t28: day {d} of lc{k} incomplete (a pause or a shared block), not counted"
                );
                skipped += 1;
            }
        }
        let took = day_started.elapsed().as_secs_f64();
        if took > 20.0 {
            println!("C11 t28: day {d} took {took:.0} s");
        }
        d += 1;
    }
    let draws = slots.iter().sum::<u32>();
    let expected = f64::from(draws) / 3.0;
    let chi2: f64 = slots
        .iter()
        .map(|&o| (f64::from(o) - expected).powi(2) / expected)
        .sum();
    println!(
        "C11 t28: hero slots over {draws} draws ({} days × {instances} deployments, {skipped} \
         skipped): {slots:?} (expected {expected:.1} each), χ² = {chi2:.2} (df 2, p = 0.001 bound \
         13.82); {:.0} s",
        d - act,
        started.elapsed().as_secs_f64()
    );
    assert!(slots.iter().all(|&s| s > 0));
    assert!(chi2 < 13.82, "hero slots are not uniform: {slots:?}");
    for g in &games {
        g.check_invariants().await;
    }
}
