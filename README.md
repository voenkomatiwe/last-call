# Last Call ($LAST)

Last Call is a NEAR memecoin built to run with no keys, and a daily game. Every day the community has to hit a
check-in goal: hit it and the pot pays everyone who checked in, a random closer wins a jackpot, and
the streak grows; miss it and part of the pot and of the absentees' stakes burns for good. The
contract mints nothing after launch, and once its last access key is deleted (see
[Deployment](#deployment)) nobody, including us, can change the rules or take the pot.

Built for NEAR HACKATHON 2026, memecoins track. All code was written during the hackathon (first
commit 7 November 2026, 22:26 UTC).

## Rules

1. Half of the fixed supply (10⁹ LAST) is locked in the contract as the **pot**. Nobody controls it.
2. To play, you **join** by locking a stake of LAST. You count after a short warm-up.
3. Every day each member may **check in** once: one `check_in()` transaction, paid by the player.
4. The day's **goal** is 60% of active members (at least `min_goal`). It is fixed when the day opens.
5. **Goal reached:** a share of the pot is split among everyone who checked in; the longer the
   **streak** of successful days, the bigger the share (up to `streak_cap`).
6. **Closers and the hero:** the last 5 check-ins before the goal (at most one per block) are the
   day's closers. One of them, drawn at random in a separate receipt, wins a **jackpot** worth 10
   shares.
7. **Goal missed:** 5% of the pot burns, every active member who did not check in loses 10% of
   their stake, and the streak resets to zero. Members still in warm-up are not slashed.
8. Members who skip too many days in a row can be **kicked** by anyone. Leaving costs an exit fee
   unless you checked in today or are still in warm-up. Rewards are claimed with `claim()`.

Parameters (`config/params.json`; the live contract returns them from `get_config()`):

| Parameter | testnet | demo (sandbox) | Meaning |
|---|---|---|---|
| `day_length_s` | 600 | 60 | Length of a game day, seconds |
| `warmup_days` | 2 | 1 | Days before a new member counts |
| `goal_bps`, `min_goal` | 6000, 5 | 6000, 3 | Goal = max(`min_goal`, ceil(active × 60%)) |
| `closers_k` | 5 | 5 | Hero candidates per day |
| `jackpot_mult` | 10 | 10 | Jackpot in shares |
| `emit_bps` | 5 | 100 | Base share of the pot spent on a successful day |
| `streak_step_bps`, `streak_cap` | 1000, 30 | 1000, 10 | +10% per streak day, capped |
| `burn_bps` | 500 | 500 | Pot burnt on a failed day |
| `slash_bps` | 1000 | 1000 | Stake burnt per missed failed day; also the exit fee |
| `join_stake` | 100 000 LAST | 1 000 LAST | Stake locked by `join` |
| `faucet_amount` | 0 (off) | 5 000 LAST | One-time faucet |
| `inactive_days` | 6 | 3 | Missed days after which anyone may kick |
| `kick_bounty_bps` | 2000 | 2000 | Share of the kicked member's fee paid to the kicker |

The full interface, formulas, events and errors are in [`contract/API.md`](contract/API.md).

## Try it

Requirements: [Bun](https://bun.sh) 1.4.4. For the contract tests, Rust via `rustup` (the toolchain
is pinned in `contract/rust-toolchain.toml`).

1. `bun install` → dependencies installed.
2. `bun run sim` → seven 60-day scenarios on the mainnet parameters print in about 5 seconds, one
   line each (`base success 58/60 streak 58 …`, `griefer success 14/60 …`); per-day CSVs and
   `out/sim-report.md` with per-profile results are written to `out/`.
3. `bun run demo` → a local NEAR sandbox (first run downloads the node, ~73 MB) runs the committed
   `contract/res/last_call.wasm` after checking its sha256. Nine players join, the contract's keys
   are deleted and the output shows `list-keys lastcall.sandbox: (empty)`. Then six 60-second days
   are played with fast-forward: day 3 has 3 of 6 check-ins and fails (`Burnt … from the pot and
   … from absent stakes`), the others succeed with closers and a hero each, and a final table of
   balances is printed. About 40 seconds.
4. `cd contract && cargo test` → 255 unit tests pass (about 3 minutes on the first build). The
   integration tests on the real wasm in a sandbox (`contract/tests/sandbox.rs`) are opt-in and
   slow; the command to run them is at the top of that file.
5. Check the live testnet contract with [near-cli-rs](https://github.com/near/near-cli-rs):
   `near account list-keys v1.last-call.testnet network-config testnet now` lists the contract's
   access keys (see [Deployment](#deployment)).
6. The web app: `cp web/.env.example web/.env.local`, set
   `NEXT_PUBLIC_CONTRACT_ID=v1.last-call.testnet`, run `bun run dev` and open
   http://localhost:3000 → the live state of the testnet game (day, goal, check-ins, pot, history).
   Connect a NEAR testnet wallet to play: register, join, and check in with the gesture (lift the
   glass and hold until it is empty). The testnet faucet is off, so joining needs 100 000 LAST from
   another holder; the sandbox demo is the full path without that.

`bun run check` runs Biome, type checking and the TypeScript tests.

## Real vs simulated

| What | Status |
|---|---|
| NEP-141 token with the game in one contract | Real: testnet `v1.last-call.testnet`; local sandbox in `bun run demo` |
| Check-ins, closers, hero draw, burns, slashes, kicks, claims | Real, in the contract |
| Contract without access keys | Real in the demo sandbox; testnet: see [Deployment](#deployment) |
| 60 days, 110–180 accounts, farmers, snipers, griefers | Simulation (`sim/engine.ts`: the contract's formulas ported to TypeScript and reviewed against the Rust source; no automated trace comparison with the wasm yet) |
| Short days (60 s demo, 600 s testnet) | Demo and testnet parameters; the mainnet set uses 24 h days |
| Mainnet | Not deployed |
| Check-in without a wallet popup | Real: an optional browser key added to the player's own account as a function-call key limited to `check_in`; the player still pays the gas |
| Gasless signed check-in (`check_in_signed`, NEP-413) | In the contract and in the relayer code (`/api/checkin`); not enabled on testnet, because the platform does not pay players' gas |

## Why there is no mint

The track prompt suggests minting rewards when a goal is met. Last Call does the opposite: the
supply is fixed at launch and half of it is locked in the contract as the pot. Rewards and jackpots
are transfers out of the pot, and every failed day burns 5% of it, so the supply can only shrink.
The contract has no mint function, and after its last access key is deleted nobody can create
tokens, change parameters or upgrade the code. The price is a natural horizon: the pot shrinks with every payout and burn, which
is where the name comes from.

## How we differ from the starter idea

What Last Call adds to the track's starter idea of a community check-in goal:

| Aspect | Last Call |
|---|---|
| Goal | 60% of the members active that day (at least `min_goal`), fixed when the day opens |
| Who wins | Everyone who checks in shares the reward; the last 5 check-ins before the goal are the closers, and one of them, drawn in a separate receipt, wins a 10-share jackpot |
| Cost of skipping | A failed day burns 5% of the pot and 10% of the stake of every active member who skipped |
| Rewards | Not minted, unlike the prompt's suggestion: they come out of a pot locked at launch, so the supply only shrinks |
| Evidence | A TypeScript port of the contract's day logic (`sim/engine.ts`) runs 60-day scenarios with farmers, snipers and griefers; it is reviewed against the Rust source, not yet compared with the wasm automatically |

## Limits

The mechanics make Sybil attacks expensive, not impossible. Check-ins measure staked seats, not
people.

- **Seats cost stake.** A player with N seats gets N shares and pays N stakes; their return on stake
  is the same as everyone's.
- **Warm-up** stops last-minute seats from saving or sinking a day.
- **Snipers take the jackpots.** Closers are the last check-ins before the goal, one per block. In
  the `sniper-blocks` simulation, 5 accounts (4.3%) that wait until the count is close to the goal
  and check in from separate blocks took 290 of 290 closer seats and 58 of 58 jackpots. Sending
  them in one block cuts that to 15 of 58. This is a known, accepted weakness of the current
  contract.
- **Griefers burn the pot but pay for it.** 70 griefers who never check in and rejoin after each
  kick fail 44 of 60 days and bring the pot from 500 M to 52 M LAST, losing 24 M LAST themselves. A
  griefer who checks in once every `inactive_days` days cannot be kicked (`walker` scenario).
- **The block producer** can influence `random_seed`, which picks the hero.
- **A relayer** could withhold or reorder signed check-ins; direct `check_in()` always works.

Full simulation results: `bun run sim`, then `out/sim-report.md`.

## Deployment

- Testnet contract: `v1.last-call.testnet`, 600-second days.
- Its `code_hash` (`mNpGAXTdohEQCvtHBxVhzUhKjbDhewkQpn3pM3qcgWh`) is the base58 form of the sha256
  in `contract/res/last_call.wasm.sha256`, so the deployed code is the committed wasm. The wasm is
  built reproducibly with `cargo near build reproducible-wasm` (image in `contract/Cargo.toml`).
- As of 13 November 2026 the testnet account still holds one full-access key; it will be deleted
  before submission, after which `list-keys` returns nothing. Until then the "no keys" claims above
  describe the launch state, not the current one: check with
  `near account list-keys v1.last-call.testnet network-config testnet now`.

## Repository

- `contract/`: Rust contract (near-sdk 5.30.1, near-contract-standards 5.30.1), unit and sandbox
  tests, committed wasm in `contract/res/`.
- `sim/`: TypeScript simulation of the day logic and the scenarios (`bun run sim`).
- `scripts/`: the sandbox demo (`bun run demo`) and sandbox helpers.
- `web/`: Next.js app and its server routes (game views, optional relayer).
- `config/params.json`: the mainnet, testnet and demo parameter sets.

## Libraries and AI use

- Contract: near-sdk 5.30.1, near-contract-standards 5.30.1; tests: near-sandbox 0.4.0,
  near-api 0.8.7, tokio, ed25519-dalek.
- TypeScript: Bun 1.4.4, near-api-js 7.4.0, near-sandbox 0.3.5, Next.js 16.4.6, React 19.3.1,
  @hot-labs/near-connect 0.12.0, @tanstack/react-query 5.107.1, GSAP 3.15.1, Biome 2.6.7.
- AI: most of the TypeScript (simulation, scripts, web app, relayer) and the documentation was
  written with Claude Code under human review; the contract was written by the team's Rust
  developer with AI assistance.

## Credits

- Interface icons: [Solar Bold Duotone Icons](https://www.svgrepo.com/collection/solar-bold-duotone-icons/) by 480 Design, via SVG Repo (listed as CC0), in `web/src/game/bar/icons.tsx`.
- People in the bar: [Open Peeps](https://www.openpeeps.com/) by Pablo Stanley (CC0), assembled from parts with different faces (`web/public/bar/peeps/`).
- Sounds (`web/public/bar/sfx/`), trimmed and peak-normalised, from Wikimedia Commons:
  [Burp.wav](https://commons.wikimedia.org/wiki/File:Burp.wav) by TheVelocity (CC BY-SA 4.0);
  [Flatus.wav](https://commons.wikimedia.org/wiki/File:Flatus.wav) and
  [Flatulence.wav](https://commons.wikimedia.org/wiki/File:Flatulence.wav) by JohnSumisu (CC BY-SA 3.0);
  [Menselijke wind drietraps.wav](https://commons.wikimedia.org/wiki/File:Menselijke_wind_drietraps.wav) by
  BeatsByDrProcolHarum (CC BY-SA 4.0). The trimmed files are shared under the same licences.

## Team and post

- Team: to be filled in before submission.
- X post with the video: pending; the link is added here once it is published.

## License

MIT, see [LICENSE](LICENSE).
