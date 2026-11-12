//! Deterministic fuzz (S18 9b): random calls with random weights, the reference model and all
//! invariants after every call (`World`), expected errors rolled back and checked against the
//! model, "everyone left / everyone came back" in every run.
//!
//! Reproduce a failure: the panic names the parameter set, the seed and the call; run
//! `fuzz_one(seed, set)` from a scratch test with the same arguments.

use std::time::Instant;

use ed25519_dalek::SigningKey;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, PublicKey};

use super::*;
use crate::test_utils::{ParamSet, params, user};

/// Days per run.
const DAYS: u32 = 120;

/// xorshift64* (Vigna): deterministic, no dependency.
pub(crate) struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        // splitmix64 of the seed: never 0, nearby seeds diverge at once.
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Rng((z ^ (z >> 31)) | 1)
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// In `0..n` (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    /// True with probability `pct` %.
    pub fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    pub fn seed32(&mut self) -> [u8; 32] {
        let mut s = [0u8; 32];
        for chunk in s.chunks_mut(8) {
            chunk.copy_from_slice(&self.next().to_le_bytes());
        }
        s
    }
}

/// The demo set with `join_stake = 10^23` (dust from the 24th missed failure, R1).
fn demo_big_stake() -> ParamSet {
    let mut p = params("demo");
    p.config.join_stake = U128(100_000_000_000_000_000_000_000);
    p
}

/// A random valid configuration (S3): edge values of every parameter (stake 1 yocto, no emission,
/// no jackpot, K = 1, goal 100% or 0%, slash and burn 0 or 100%, warmup up to 3 days, …).
fn random_params(seed: u64) -> ParamSet {
    let mut rng = Rng::new(seed ^ 0xC0FF_EE00);
    let mut p = params("demo");
    let c = &mut p.config;
    c.warmup_days = 1 + rng.below(3) as u32;
    c.goal_bps = *rng.pick(&[0, 3000, 6000, 10_000]);
    c.min_goal = 1 + rng.below(4) as u32;
    c.closers_k = *rng.pick(&[1, 2, 5, 16]);
    c.jackpot_mult = *rng.pick(&[0, 1, 10, 1000]);
    c.emit_bps = *rng.pick(&[0, 5, 100, 1000, 10_000]);
    c.streak_step_bps = *rng.pick(&[0, 1000, 10_000]);
    c.streak_cap = rng.below(31) as u32;
    // emit_bps × (B + cap × step) ≤ 10^8.
    while u128::from(c.emit_bps) * (B + u128::from(c.streak_cap) * u128::from(c.streak_step_bps))
        > 100_000_000
    {
        c.streak_cap /= 2;
        if c.streak_cap == 0 {
            c.streak_step_bps = 0;
        }
    }
    c.burn_bps = *rng.pick(&[0, 500, 10_000]);
    c.slash_bps = *rng.pick(&[0, 1000, 5000, 10_000]);
    c.join_stake = U128(*rng.pick(&[
        1,
        7,
        1_000_000_000_000_000_000_000,
        1_000_000_000_000_000_000_007,
        100_000_000_000_000_000_000_000,
    ]));
    c.inactive_days = 1 + rng.below(5) as u32;
    c.kick_bounty_bps = *rng.pick(&[0, 2000, 10_000]);
    p.pot_bps = *rng.pick(&[0, 5000, 9000]);
    p.faucet_bps = *rng.pick(&[0, 100]);
    p.config.faucet_amount = U128(*rng.pick(&[0, 5_000_000_000_000_000_000_000]));
    p
}

/// One account of the run: its id and its check-in key pair.
struct Player {
    id: AccountId,
    sk: SigningKey,
    pk: PublicKey,
    /// Chance (%) to check in during the daily wave: diligent, lazy or gone.
    diligence: u64,
}

struct Fuzz {
    w: World,
    rng: Rng,
    players: Vec<Player>,
    /// `pick_hero` promises in flight: (day, calls left before the runtime executes it).
    promises: Vec<(u32, u32)>,
    day: u32,
    offset_s: u64,
    day_length_s: u64,
    stake: u128,
}

impl Fuzz {
    fn new(seed: u64, p: ParamSet) -> Fuzz {
        let mut rng = Rng::new(seed);
        let stake = p.config.join_stake.0;
        let day_length_s = p.config.day_length_s;
        let mut w = World::deploy(p);
        w.thorough = false;
        let n = 8 + rng.below(8) as u32;
        let players = (0..n)
            .map(|i| {
                let (sk, pk) = key_pair(seed.wrapping_mul(1_000).wrapping_add(u64::from(i)));
                let diligence = *rng.pick(&[99, 97, 92, 85, 60, 25, 0]);
                Player {
                    id: user(i),
                    sk,
                    pk,
                    diligence,
                }
            })
            .collect();
        Fuzz {
            w,
            rng,
            players,
            promises: Vec::new(),
            day: 0,
            offset_s: 0,
            day_length_s,
            stake,
        }
    }

    fn members(&self) -> Vec<AccountId> {
        self.w.m.members.keys().cloned().collect()
    }

    fn any_account(&mut self) -> AccountId {
        if self.rng.chance(5) {
            return "stranger.near".parse().expect("id");
        }
        self.rng.pick(&self.players).id.clone()
    }

    /// A member most of the time, any account otherwise.
    fn some_member(&mut self, pct: u64) -> AccountId {
        let members = self.members();
        if !members.is_empty() && self.rng.chance(pct) {
            return self.rng.pick(&members).clone();
        }
        self.any_account()
    }

    fn player(&self, a: &AccountId) -> Option<&Player> {
        self.players.iter().find(|p| p.id == *a)
    }

    /// Queues the `pick_hero` promises the last call created, each with a delay of 0–3 calls.
    fn collect_promises(&mut self) {
        for day in self.w.new_pick_hero_promises() {
            let delay = self.rng.below(4) as u32;
            self.promises.push((day, delay));
        }
    }

    /// Promises whose delay ran out are executed by the runtime (5% are lost: out of gas).
    fn step_promises(&mut self) {
        let mut due = Vec::new();
        self.promises.retain_mut(|(day, delay)| {
            if *delay == 0 {
                due.push(*day);
                false
            } else {
                *delay -= 1;
                true
            }
        });
        for day in due {
            if self.rng.chance(5) {
                continue;
            }
            let seed = self.rng.seed32();
            self.w.pick_hero(day, seed);
        }
    }

    fn low_gas(&mut self) {
        self.w.low_gas = self.rng.chance(4);
    }

    fn advance(&mut self, days: u32) {
        if days == 0 {
            let left = self.day_length_s - 1 - self.offset_s;
            if left > 0 {
                self.offset_s += 1 + self.rng.below(left);
            }
        } else {
            self.day += days;
            self.offset_s = self.rng.below(self.day_length_s);
        }
        self.w.goto(self.day, self.offset_s);
        if days > 0 && self.rng.chance(85) {
            self.wave();
        }
    }

    /// The day's check-ins: every member by its diligence, in random order, now and then several
    /// in one block.
    fn wave(&mut self) {
        let mut order = self.members();
        for i in (1..order.len()).rev() {
            order.swap(i, self.rng.below(i as u64 + 1) as usize);
        }
        for a in order {
            let diligence = self.player(&a).map_or(0, |p| p.diligence);
            if !self.rng.chance(diligence) {
                continue;
            }
            self.step_promises();
            if self.rng.chance(15) {
                // Same block as the previous call.
                self.w.auto_block = false;
            }
            if self.rng.chance(5) {
                self.signed(&a);
            } else {
                self.check_in(&a);
            }
            self.w.auto_block = true;
        }
    }

    fn join(&mut self, a: &AccountId) {
        let player = self.player(a).map(|p| p.pk.clone());
        // Usually funded with exactly what is missing; sometimes not (ERR_NOT_REGISTERED /
        // ERR_INSUFFICIENT_BALANCE).
        if self.rng.chance(90) {
            let have = self.w.m.balance(a);
            if have < self.stake || !self.w.m.balances.contains_key(a) {
                self.w.fund(a, self.stake - have.min(self.stake));
            }
        }
        let key = match self.rng.below(20) {
            0 => Some(bad_key()),
            1..=8 => player,
            _ => None,
        };
        let deposit = match self.rng.below(20) {
            0 => 0,
            1 => DEPOSIT - 1,
            2..=6 => DEPOSIT + 1 + u128::from(self.rng.below(1_000_000)),
            _ => DEPOSIT,
        };
        self.low_gas();
        let _ = self.w.join_with(a, key, deposit);
        self.collect_promises();
    }

    fn check_in(&mut self, a: &AccountId) {
        self.low_gas();
        let _ = self.w.check_in(a);
        self.collect_promises();
    }

    /// 2–6 check-ins in one block (R5: only the first can be a candidate).
    fn batch(&mut self) {
        let n = 2 + self.rng.below(5);
        self.w.next_block();
        self.w.auto_block = false;
        for _ in 0..n {
            let a = self.some_member(90);
            if self.rng.chance(20) {
                self.signed(&a);
            } else {
                self.check_in(&a);
            }
        }
        self.w.auto_block = true;
    }

    /// `check_in_signed` relayed by a random account: valid, or signed for yesterday, by another
    /// key, with a 31-byte nonce or a corrupted signature.
    fn signed(&mut self, a: &AccountId) {
        let today = self.w.today();
        let current_key = self.w.member(a).and_then(|m| m.checkin_key.clone());
        let Some(p) = self.player(a) else {
            return;
        };
        let (mut signer, pk) = (p.sk.clone(), p.pk.clone());
        let mut nonce = self.rng.seed32();
        let mut day = today;
        let (mut foreign, mut short) = (false, false);
        match self.rng.below(10) {
            0 => day = today.saturating_sub(1),
            1 => {
                signer = key_pair(self.rng.next()).0;
                foreign = true;
            }
            2 => short = true,
            _ => {}
        }
        nonce[0] = nonce[0].wrapping_add(1);
        let mut signature = sign_check_in(&signer, a, day, nonce);
        let corrupted = self.rng.chance(5);
        if corrupted {
            signature[0] ^= 1;
        }
        let nonce = if short {
            nonce[..31].to_vec()
        } else {
            nonce.to_vec()
        };
        let sig_ok = current_key.as_ref() == Some(&pk) && !foreign && !short && !corrupted;
        let relayer = self.any_account();
        self.low_gas();
        let _ = self
            .w
            .check_in_signed(&relayer, a, day, nonce, signature, sig_ok);
        self.collect_promises();
    }

    fn kick(&mut self) {
        // Prefer a kickable member: most random kicks would only be too early.
        let today = self.w.today();
        let kickable: Vec<AccountId> = self
            .w
            .m
            .members
            .iter()
            .filter(|(_, mm)| self.w.m.kickable(mm, today))
            .map(|(a, _)| a.clone())
            .collect();
        let target = if !kickable.is_empty() && self.rng.chance(60) {
            self.rng.pick(&kickable).clone()
        } else {
            self.some_member(90)
        };
        let caller = self.any_account();
        self.low_gas();
        let _ = self.w.kick(&caller, &target);
        self.collect_promises();
    }

    fn ft_transfer(&mut self) {
        let from = self.any_account();
        let to = if self.rng.chance(5) {
            contract_id()
        } else {
            self.any_account()
        };
        let balance = self.w.m.balance(&from);
        let amount = match self.rng.below(10) {
            0 => 0,
            1 | 2 => balance + 1 + u128::from(self.rng.below(1000)),
            3 | 4 => u128::from(self.rng.below(1_000_000)),
            _ if balance > 0 => 1 + (u128::from(self.rng.next()) % balance),
            _ => 1,
        };
        let _ = self.w.ft_transfer(&from, &to, amount);
    }

    fn set_key(&mut self) {
        let a = self.some_member(90);
        let key = match self.rng.below(10) {
            0 => Some(bad_key()),
            1 | 2 => None,
            3 => Some(key_pair(self.rng.next()).1),
            _ => self.player(&a).map(|p| p.pk.clone()),
        };
        let _ = self.w.set_checkin_key(&a, key);
    }

    /// Everyone leaves (catching up the days first if the backlog is too long).
    fn everyone_leaves(&mut self) {
        if self.w.today() - self.w.m.next() > AUTO_SETTLE_CAP {
            self.w
                .settle(None)
                .expect("settle never fails with full gas");
            self.collect_promises();
        }
        self.w.low_gas = false;
        for a in self.members() {
            self.w.leave(&a).expect("leave of a member");
            self.collect_promises();
        }
        assert_eq!((self.w.c.stake_pool, self.w.c.active_stake), (0, 0), "R11");
        assert_eq!(self.w.c.members_total, 0);
        assert_eq!(
            (self.w.c.open.active_stake, self.w.c.open.checked_stake),
            (0, 0)
        );
    }

    /// Every player joins again.
    fn everyone_joins(&mut self) {
        self.w.low_gas = false;
        let ids: Vec<AccountId> = self.players.iter().map(|p| p.id.clone()).collect();
        for a in ids {
            if self.w.member(&a).is_none() {
                let _ = self.w.fund_and_join(&a, None);
                self.collect_promises();
            }
        }
    }

    fn step(&mut self) {
        self.step_promises();
        let roll = self.rng.below(1000);
        match roll {
            0..300 => {
                let a = self.some_member(85);
                self.check_in(&a);
            }
            300..340 => self.batch(),
            340..352 => {
                let a = self.some_member(90);
                self.signed(&a);
            }
            352..432 => {
                let a = self.some_member(15);
                self.join(&a);
            }
            432..482 => {
                let a = self.some_member(90);
                let deposit = if self.rng.chance(4) { 0 } else { 1 };
                self.low_gas();
                let _ = self.w.claim_with(&a, deposit);
                self.collect_promises();
            }
            482..512 => {
                let a = self.some_member(90);
                let deposit = if self.rng.chance(4) { 2 } else { 1 };
                self.low_gas();
                let _ = self.w.leave_with(&a, deposit);
                self.collect_promises();
            }
            512..562 => self.kick(),
            562..592 => {
                let max = if self.rng.chance(30) {
                    None
                } else {
                    Some(self.rng.below(4) as u32)
                };
                self.low_gas();
                let _ = self.w.settle(max);
                self.collect_promises();
            }
            592..722 => {
                let days = self.rng.below(4) as u32;
                self.advance(days);
            }
            722..723 => {
                // Backlog beyond AUTO_SETTLE_CAP: game calls fail until a settle.
                let days = 51 + self.rng.below(5) as u32;
                self.advance(days);
            }
            723..740 => {
                let mut days: Vec<u32> = self.w.m.pending_heroes.iter().map(|p| p.day).collect();
                days.push(self.w.today());
                let day = *self.rng.pick(&days);
                let caller = self.any_account();
                self.low_gas();
                let _ = self.w.retry_pick_hero(&caller, day);
                self.collect_promises();
            }
            740..780 => self.ft_transfer(),
            780..790 => {
                let a = self.some_member(10);
                let force = self.rng.chance(70);
                let _ = self.w.storage_unregister(&a, force);
            }
            790..800 => {
                let a = self.any_account();
                let _ = self.w.faucet(&a);
            }
            800..815 => self.set_key(),
            _ => {
                let a = self.some_member(85);
                self.check_in(&a);
            }
        }
        self.w.low_gas = false;
    }
}

/// Prints the failing run's coordinates if the run panics.
struct Coordinates<'a> {
    set: &'a str,
    seed: u64,
}

impl Drop for Coordinates<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("fuzz failure: set {}, seed {}", self.set, self.seed);
        }
    }
}

/// One run: `DAYS` days of random calls; "everyone leaves" and "everyone joins again" once in the
/// middle; all members leave at the end (R11: the dust goes to the pot).
pub(crate) fn fuzz_one(seed: u64, set: &str) -> Stats {
    let _coordinates = Coordinates { set, seed };
    let p = match set {
        "demo" => params("demo"),
        "demo-1e23" => demo_big_stake(),
        "random" => random_params(seed),
        other => panic!("unknown fuzz set {other}"),
    };
    let mut f = Fuzz::new(seed, p);
    let exodus_day = 20 + f.rng.below(u64::from(DAYS) - 50) as u32;
    let (mut exodus, mut back) = (false, false);
    while f.w.today() < DAYS {
        f.step();
        if !exodus && f.w.today() >= exodus_day {
            f.everyone_leaves();
            exodus = true;
        } else if exodus && !back && f.w.today() >= exodus_day + 3 {
            f.everyone_joins();
            back = true;
        }
    }
    while !f.promises.is_empty() {
        f.step_promises();
    }
    f.everyone_leaves();
    f.w.check_full();
    for d in &f.w.m.days {
        let outcome = match d.outcome {
            Outcome::Success if d.per_share.0 > 0 => "Success",
            Outcome::Success => "Success without a share",
            Outcome::Fail => "Fail",
            Outcome::Idle => "Idle",
        };
        f.w.stats.add("day", outcome);
    }
    f.w.stats
}

/// Runs the seeds of `seeds`; `C9_FUZZ_RUNS=n` keeps only the first `n` of each range (quick runs,
/// e.g. under cargo-mutants).
fn fuzz_many(set: &str, seeds: std::ops::Range<u64>) {
    let started = Instant::now();
    let limit = std::env::var("C9_FUZZ_RUNS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(u64::MAX);
    let seeds = seeds.start..seeds.end.min(seeds.start.saturating_add(limit));
    let runs = seeds.end - seeds.start;
    let mut stats = Stats::default();
    for seed in seeds {
        stats.merge(&fuzz_one(seed, set));
    }
    let calls: u64 = stats.calls.values().sum();
    eprintln!(
        "fuzz {set}: {runs} runs × {DAYS} days, {calls} calls in {:?}",
        started.elapsed()
    );
    for (k, v) in &stats.calls {
        eprintln!("  {k}: {v}");
    }
    eprintln!(
        "  max dust: stake_pool {} yocto, active_stake {} yocto",
        stats.max_dust, stats.max_active_dust
    );
}

// 200 runs with join_stake = 10^23 (R1 dust), split for the parallel test runner, plus the
// original demo set.

#[test]
fn t09b_fuzz_demo_1e23_a() {
    fuzz_many("demo-1e23", 0..50);
}

#[test]
fn t09b_fuzz_demo_1e23_b() {
    fuzz_many("demo-1e23", 50..100);
}

#[test]
fn t09b_fuzz_demo_1e23_c() {
    fuzz_many("demo-1e23", 100..150);
}

#[test]
fn t09b_fuzz_demo_1e23_d() {
    fuzz_many("demo-1e23", 150..200);
}

#[test]
fn t09b_fuzz_demo_original() {
    fuzz_many("demo", 1_000..1_050);
}

/// Random valid configurations, one per run.
#[test]
fn fuzz_random_configs_a() {
    fuzz_many("random", 2_000..2_030);
}

#[test]
fn fuzz_random_configs_b() {
    fuzz_many("random", 2_030..2_060);
}

/// Deeper sweep, not in the default run: `cargo test --lib tests::fuzz::fuzz_deep -- --ignored`
/// (`C9_FUZZ_RUNS=n` runs per set, 300 by default; `C9_FUZZ_SEED=s` first seed, 10 000 by default).
#[test]
#[ignore = "long: optional deeper fuzz sweep"]
fn fuzz_deep() {
    let var = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default)
    };
    let (n, first) = (var("C9_FUZZ_RUNS", 300), var("C9_FUZZ_SEED", 10_000));
    for set in ["random", "demo-1e23"] {
        fuzz_many(set, first..first + n);
    }
}
