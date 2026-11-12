# Last Call contract API

Reference for the frontend and scripts: every public method of the `last_call` contract, what to
attach, what comes back, which errors and events to expect. The contract source is the
authority; this file is written by hand from it and from `docs/plans/contract-spec.md`. The machine-readable ABI comes from
`cargo near abi` (run in `contract/`, output in `target/near/last_call_abi.json`).

Contents: [Conventions](#conventions) · [Parameters](#parameters) · [Flows](#flows) ·
[Change methods](#change-methods) · [View methods](#view-methods) ·
[Token and storage standards](#token-and-storage-standards) · [Events](#events) ·
[Errors](#errors) · [Signed check-in payload](#signed-check-in-payload-nep-413) · [Limits](#limits)

## Conventions

- **Amounts.** `$LAST` has 18 decimals. Every token amount, and every yoctoNEAR amount
  (`member_storage_deposit`, `storage_deposit`), is a `U128`: a decimal string such as
  `"1000000000000000000000"`. Parse with `BigInt`, never `Number`.
- **Basis points.** Every `*_bps` field is out of `10 000` (`2000` = 20 %).
- **Days.** Day numbers are `u32`, counted from `launch_ns` (set at deploy):
  `today = floor((block_timestamp − launch_ns) / (day_length_s × 10⁹))`. `launch_ns` is a decimal
  string (`U64`), because it exceeds 2⁵³. Use `today` and `ms_to_day_end` from `get_state` rather
  than the browser clock.
- **Settled and open days.** Days end by time but are settled lazily: the next game call (or anyone
  calling `settle`) closes every finished day. `get_state().last_settled` is the last closed day,
  `pending_days = today − (last_settled + 1)` is how many finished days wait to be settled, and the
  open day (`get_open_day`) is the first unsettled day. Views compute member values over settled
  days only.
- **Auto-settle.** `join`, `check_in`, `check_in_signed`, `claim`, `leave` and `kick` settle pending
  days first. If more than `auto_settle_cap` (50) days are pending they fail with `ERR_BACKLOG`
  before doing any work; call `settle` first (see [Flows](#settle-and-heroes)).
- **Errors.** A failed call panics with a string that starts with `ERR_`. In near-api-js and wallet
  results it appears inside the failure text, for example
  `Smart contract panicked: ERR_ALREADY_CHECKED_IN`. Match on the `ERR_*` token. Token standard
  methods keep the near-contract-standards messages (for example
  `Requires attached deposit of exactly 1 yoctoNEAR`).
- **Events.** Logs in NEP-297 format: `EVENT_JSON:{"standard":...,"version":...,"event":...,"data":...}`.
  Game events use the standard `lastcall` (version `1.0.0`) and `data` is an object; token events
  use `nep141` and `data` is an array. See [Events](#events).
- **Gas.** Unused gas is refunded, so generous limits cost nothing. Measured on nearcore 2.14.0 by
  the sandbox tests (`contract/tests/sandbox.rs`; run with `--nocapture` to print the figures):

  | Call | Burnt | Attach |
  |---|---|---|
  | `join`, `check_in`, `claim`, `leave`, `kick` | 1.3–3 Tgas; 15.5 Tgas with 50 days of auto-settle | 50–100 Tgas |
  | `check_in_signed` | ≈ 2 Tgas per action; a batch of 5 burnt 10.1 Tgas | 30–50 Tgas per action (the first one of the day may auto-settle) |
  | `settle(null)` | 2.3 Tgas for one day; 45.7 Tgas for 500 days | 100–300 Tgas |
  | `retry_pick_hero` | the draw itself burns ≈ 2.5 Tgas | 50+ Tgas |

  When a call is about to settle days and the first of them succeeded (and in `retry_pick_hero`),
  it checks at the start, before any work, that at least 15 Tgas remain for scheduling the hero
  draw; otherwise it fails with `ERR_LOW_GAS` and changes nothing. The limits above leave plenty of
  room.

## Parameters

`config/params.json` holds the three deploy sets; `get_config()` returns the live values.

| Field | mainnet | testnet | demo | Meaning |
|---|---|---|---|---|
| `day_length_s` | 86 400 | 600 | 60 | Length of a game day |
| `warmup_days` | 2 | 2 | 1 | A member who joins on day `d` is active from day `d + warmup_days` |
| `goal_bps` | 6000 | 6000 | 6000 | Daily goal: `max(min_goal, ceil(active × goal_bps / 10 000))` |
| `min_goal` | 5 | 5 | 3 | Below this many active members the day is idle (goal 0) |
| `closers_k` | 5 | 5 | 5 | Size of the closers list (hero candidates) |
| `jackpot_mult` | 10 | 10 | 10 | The jackpot is worth this many shares |
| `emit_bps` | 5 | 5 | 100 | Base share of the pot a successful day spends. Times the streak multiplier it gives the day's `budget`, split into `count + jackpot_mult` shares: one per check-in, `jackpot_mult` for the jackpot |
| `streak_step_bps`, `streak_cap` | 1000, 30 | 1000, 30 | 1000, 10 | Streak multiplier `1 + min(streak, streak_cap) × streak_step_bps / 10 000`, with the streak already counting this day |
| `burn_bps` | 500 | 500 | 500 | Share of the pot burnt on a failed day |
| `slash_bps` | 1000 | 1000 | 1000 | Share of the stake burnt for each missed failed day; also the exit fee |
| `join_stake` | 100 000 LAST | 100 000 LAST | 1000 LAST | Tokens locked by `join` |
| `member_storage_deposit` | 0.01 NEAR | 0.01 NEAR | 0.01 NEAR | NEAR attached to `join`, returned on exit |
| `faucet_amount` | 0 | 0 | 5000 LAST | One faucet claim per account; 0 disables the faucet |
| `inactive_days` | 5 | 6 | 3 | Days without a check-in after which anyone may kick |
| `kick_bounty_bps` | 2000 | 2000 | 2000 | Share of the kicked member's fee paid to the kicker |

Outside `Config`: total supply 10⁹ LAST, half to the pot (`pot_bps` 5000), `faucet_bps` 0 / 0 / 100.

## Flows

### Onboarding

1. **Register for the token.** `storage_balance_of({account_id})` returns `null` for an
   unregistered account. Register with `storage_deposit({account_id: null, registration_only: true})`,
   attaching `storage_balance_bounds().min`.
2. **Get tokens.** On demo, `faucet()` gives `faucet_amount` once per account. Elsewhere the
   member needs `join_stake` LAST from a transfer.
3. **Join.** `join({checkin_key})` with at least `member_storage_deposit` attached (surplus is
   refunded). `checkin_key` is optional: an ed25519 public key (`"ed25519:<base58>"`) that may
   sign check-ins for this member (see [Signed check-in](#signed-check-in)).
4. **Warm-up.** The member becomes active on `activation_day` (`get_member`). Until then
   `check_in` fails with `ERR_WARMUP`; `is_active` is false.

### Daily check-in

- Show the goal and progress from `get_open_day()` (`count` of `goal`) and the countdown from
  `get_state().ms_to_day_end`. If `get_open_day().stale` is true the open day already ended and the
  view describes it until someone settles; the first call of the new day does that.
- `get_member(...).can_check_in_today` says whether the button should be enabled. It does not
  account for the backlog: if `pending_days > auto_settle_cap`, offer `settle` first.
- `check_in()` returns `{day, n, goal, in_closers}`: `n` is the member's position of the day,
  `in_closers` whether they entered the closers list (hero candidates). A later check-in can push a
  candidate out until the goal is reached; only the first check-in of each block can become a
  candidate.

### Signed check-in

For a check-in without a wallet transaction: the member registers `checkin_key` once (in `join` or
with `set_checkin_key`), the page keeps the private key, signs the NEP-413 payload for today and a
relayer submits `check_in_signed({account_id, day, nonce, signature})`. Anyone may submit it, with
no deposit; the relayer pays the gas. `day` must equal `today`. Direct `check_in()` always works
without the relayer. Byte layout: [Signed check-in payload](#signed-check-in-payload-nep-413);
test vector: `contract/tests/fixtures/nep413.json`.

### Rewards and leaving

- `get_member(...).pending_claimable` is what `claim` would pay over settled days; `claimable` is
  the part already credited. `effective_stake` is the stake after the slashes of settled days.
- `claim()` (1 yocto) pays all of it.
- `leave()` (1 yocto) returns the stake minus the exit fee, plus everything claimable, and the
  NEAR storage deposit. The fee is `slash_bps` of the stake, waived if the member already checked
  in today. A member still in warm-up leaves without a fee.
- `kick({account_id})` removes a member who has not checked in for `inactive_days` days
  (`kickable_from_day` in `get_member`; `get_kickable` lists candidates). The kicked member gets
  the same payout as `leave`; the kicker gets `kick_bounty_bps` of the fee if registered for the
  token.

### Settle and heroes

- `settle({max_days})` closes up to `max_days` (default and maximum 500) finished days and returns
  how many it closed. Anyone may call it; it never fails with `ERR_BACKLOG`. Use it when
  `pending_days > auto_settle_cap`, or to show settled results before anyone plays.
- A successful day with closers schedules the hero draw in a separate receipt (`pick_hero`), so the
  winner appears a block or two later: `get_state().pending_hero_days` lists days still waiting,
  `get_history` shows `hero` once drawn, and the `hero` event reports it. If a draw ran out of gas,
  `retry_pick_hero({day})` schedules it again.

## Change methods

Deposit column: "1 yocto" means exactly 1 yoctoNEAR. A call with a deposit must be signed with a
full-access key, so the wallet always asks the user to confirm it; a function-call access key
cannot send it. Methods with deposit 0 are not payable: any attached deposit is rejected by the
near-sdk wrapper with a panic that is not an `ERR_*` string.

| Method | Deposit | Auto-settle | Returns |
|---|---|---|---|
| `join({checkin_key})` | ≥ `member_storage_deposit` | yes | nothing |
| `check_in()` | 0 | yes | `CheckInResult` |
| `check_in_signed({account_id, day, nonce, signature})` | 0 | yes | `CheckInResult` |
| `set_checkin_key({key})` | 1 yocto | no | nothing |
| `claim()` | 1 yocto | yes | `U128` amount paid |
| `leave()` | 1 yocto | yes | `U128` stake returned |
| `kick({account_id})` | 0 | yes | `U128` bounty paid |
| `settle({max_days})` | 0 | — | `u32` days settled |
| `retry_pick_hero({day})` | 0 | no | nothing |
| `faucet()` | 0 | no | `U128` amount paid |

### `join({ checkin_key: string | null })`

Becomes a member: moves `join_stake` LAST from the caller to the contract and stores the member
record. Attach at least `member_storage_deposit`; the surplus is refunded. `checkin_key`:
`"ed25519:<base58>"` or `null`.

- Errors: `ERR_ALREADY_MEMBER`, `ERR_NOT_REGISTERED` (no token account), `ERR_INSUFFICIENT_BALANCE`
  (fewer than `join_stake` LAST), `ERR_STORAGE_DEPOSIT` (deposit too small), `ERR_BAD_KEY` (not an
  ed25519 key), `ERR_BACKLOG`, `ERR_LOW_GAS`.
- Events: `ft_transfer` (stake to the contract), `join`.

### `check_in() -> CheckInResult`

Checks in the caller for today.

- Returns `{ day: u32, n: u32, goal: u32, in_closers: bool }`.
- Errors: `ERR_NOT_MEMBER`, `ERR_WARMUP`, `ERR_ALREADY_CHECKED_IN`, `ERR_BACKLOG`, `ERR_LOW_GAS`.
- Events: `check_in` with `via: "direct"`.
- A check-in on an idle day (goal 0) is allowed and recorded; it does not affect the outcome.

### `check_in_signed({ account_id, day, nonce, signature }) -> CheckInResult`

Checks in `account_id` with a signature by its `checkin_key`. Callable by anyone (a relayer).

- Arguments: `account_id: string`, `day: u32` (must equal `today`), `nonce`: base64 of exactly 32
  bytes, `signature`: base64 of exactly 64 bytes (raw ed25519).
- Errors, in check order: `ERR_BACKLOG`, `ERR_LOW_GAS`, `ERR_NOT_MEMBER`, `ERR_NO_CHECKIN_KEY`,
  `ERR_BAD_DAY`, `ERR_BAD_SIGNATURE`, then `ERR_WARMUP`, `ERR_ALREADY_CHECKED_IN`.
- Events: `check_in` with `via: "signed"`.
- A replay is impossible: one check-in per member per day and `day == today`. Several signed
  check-ins in one transaction are allowed; only the first can become a closer.

### `set_checkin_key({ key: string | null })` — 1 yocto

Replaces the caller's `checkin_key`, or removes it with `null`.

- Errors: `ERR_ONE_YOCTO`, `ERR_NOT_MEMBER`, `ERR_BAD_KEY`.
- No event. Does not settle days and never fails with `ERR_BACKLOG`.

### `claim() -> U128` — 1 yocto

Pays the caller's claimable rewards, including shares of days settled by this call.

- Errors: `ERR_ONE_YOCTO`, `ERR_BACKLOG`, `ERR_LOW_GAS`, `ERR_NOT_MEMBER`, `ERR_NOTHING_TO_CLAIM`.
- Events: `ft_transfer`, `claim { account_id, amount }`.

### `leave() -> U128` — 1 yocto

Leaves the game. Returns the stake part of the payout (`stake − fee`); the token transfer also
includes all claimable rewards, and the NEAR storage deposit is refunded.

- Fee: `slash_bps` of the remaining stake if the member is active and has not checked in today;
  0 if they checked in today (their share of today is forfeited to the pot instead) or are in
  warm-up. The fee is burnt.
- Errors: `ERR_ONE_YOCTO`, `ERR_BACKLOG`, `ERR_LOW_GAS`, `ERR_NOT_MEMBER`.
- Events: `ft_burn` (fee, no memo) if the fee is non-zero, `ft_transfer` (payout) if non-zero,
  `leave { account_id, returned, fee_burned }`.
- A member who leaves stays in today's closers and in pending hero draws; a jackpot still reaches
  them if they keep a token account.

### `kick({ account_id }) -> U128`

Removes an inactive member: allowed from `kickable_from_day`, that is after `inactive_days` full
days without a check-in. After a last check-in on day `p` that is day `p + 1 + inactive_days`; for
a member who never checked in, `activation_day + inactive_days`. The kicked member is paid
exactly as in `leave`. Returns the bounty paid to the caller.

- Bounty: `fee × kick_bounty_bps / 10 000` if the caller is registered for the token, otherwise 0
  (the whole fee burns). A member may kick themselves.
- Errors: `ERR_BACKLOG`, `ERR_LOW_GAS`, `ERR_NOT_MEMBER` (target is not a member),
  `ERR_NOT_INACTIVE` (too early, or target in warm-up).
- Events: `ft_burn`, `ft_transfer` (bounty, payout), `kick { account_id, by, returned, fee_burned, bounty }`.
- A kick does not change the goal of the current day; it lowers the next one.

### `settle({ max_days: u32 | null }) -> u32`

Closes `min(pending_days, max_days ?? 500, 500)` finished days and returns the number closed.
Anyone may call it.

- Errors: `ERR_LOW_GAS` (only when it closes at least one day and the first of them succeeded).
- Events: at most one `ft_burn` (all burns of the batch, memo `"days <from>..<to>"`) and one
  `days_settled`. A successful day with closers schedules a `pick_hero` receipt, which emits
  `hero`.

### `retry_pick_hero({ day: u32 })`

Schedules the hero draw for `day` again, for a draw whose receipt failed. Draws nothing itself.
A second retry after a successful draw fails with `ERR_NO_PENDING_HERO`.

- Errors: `ERR_NO_PENDING_HERO`, `ERR_LOW_GAS`.

### `faucet() -> U128`

Pays `faucet_amount` LAST to the caller, once per account (demo set only).

- Errors: `ERR_FAUCET_DISABLED` (`faucet_amount == 0`), `ERR_FAUCET_USED`, `ERR_NOT_REGISTERED`,
  `ERR_FAUCET_EMPTY`.
- Events: `ft_transfer`, `faucet { account_id, amount }`.

### Not for the frontend

- `new(...)`: the initializer, called once at deploy (`config`, `total_supply`, `pot_bps`,
  `faucet_bps`, `initial_holder`, `metadata`). Rejects invalid parameters with `ERR_BAD_CONFIG`.
- `pick_hero({day})`: private; only the contract's own promise may call it ("Method pick_hero is
  private" for anyone else).
- `ft_resolve_transfer(...)`: private callback of `ft_transfer_call`.

## View methods

All views are free and need no account. `null` arguments may be omitted.

### `get_state() -> StateView`

| Field | Type | Meaning |
|---|---|---|
| `today` | u32 | Current day by block time |
| `last_settled` | u32 \| null | Last settled day; `null` before the first settle |
| `pending_days` | u32 | Finished days not settled yet |
| `ms_to_day_end` | u64 | Milliseconds until `today` ends |
| `pot` | U128 | Shared pot: pays rewards, burns on failure |
| `reserved` | U128 | Rewards credited to members and not yet claimed |
| `stake_pool` | U128 | All members' stakes |
| `active_stake` | U128 | Stakes of active members |
| `jackpot_pending` | U128 | Jackpots waiting for their hero draw |
| `pending_hero_days` | u32[] | Days whose hero draw has not run yet |
| `faucet_left` | U128 | Tokens left in the faucet |
| `streak`, `longest_streak` | u32 | Community streak of successful days, and its record |
| `active_count` | u32 | Active members (past warm-up) |
| `members_total` | u32 | All members, including warm-up |
| `total_supply` | U128 | Current supply (falls with burns) |
| `total_burned`, `total_rewarded`, `total_jackpots` | U128 | Totals since launch |

`active_count` and `active_stake` change when a day opens (settle) and on join, leave and kick;
they are not computed from `today`. While `pending_days > 0`, members whose activation day has
passed but is not settled yet are missing from them, although `get_member(...).is_active` is
already true.

The page computes anything else, such as how many days the pot lasts (the contract uses no floats).

### `get_open_day() -> OpenDayView`

| Field | Type | Meaning |
|---|---|---|
| `day` | u32 | The first unsettled day |
| `goal` | u32 | Check-ins needed; 0 on an idle day |
| `count` | u32 | Check-ins so far |
| `active` | u32 | Active members when the day opened (the goal is based on it; it does not drop when members leave) |
| `forfeited` | u32 | Members who checked in and then left that day |
| `closers` | string[] | Hero candidates so far, oldest first, at most `closers_k` |
| `is_idle` | bool | `goal == 0` |
| `stale` | bool | `day < today`: the day ended and waits to be settled |

### `get_member({ account_id }) -> MemberView | null`

`null` for a non-member. Raw fields as stored:

| Field | Type | Meaning |
|---|---|---|
| `stake` | U128 | Stake as of `resolved_through` (before slashes of later days) |
| `join_day`, `activation_day` | u32 | Day joined; first active day |
| `last_checkin` | u32 \| null | Last day checked in |
| `resolved_through` | u32 | Days before this one are applied to `stake` and `claimable` |
| `claimable` | U128 | Rewards already credited |
| `checkins` | u32 | Total check-ins |
| `personal_streak`, `best_personal_streak` | u32 | Consecutive days checked in (as of `last_checkin`), and the record |
| `hero_count` | u32 | Jackpots won while a member |
| `storage_deposit` | U128 | yoctoNEAR held and refunded on exit |
| `checkin_key` | string \| null | Registered public key (not a secret); compare with the local key |

Derived fields for display:

| Field | Type | Meaning |
|---|---|---|
| `effective_stake` | U128 | Stake after slashes of all settled days |
| `pending_claimable` | U128 | What `claim` pays over settled days |
| `is_active` | bool | `activation_day ≤ today` |
| `checked_in_today` | bool | `last_checkin == today` |
| `can_check_in_today` | bool | `is_active && !checked_in_today` (ignores the backlog) |
| `current_personal_streak` | u32 | `personal_streak`, or 0 if the last check-in is older than yesterday |
| `kickable_from_day` | u32 \| null | First day anyone may kick this member; `null` in warm-up |

If `pending_days > 0`, `effective_stake` and `pending_claimable` do not yet include the finished
unsettled days; show them as "not settled yet" or call `settle` first.

### `get_history({ limit: u32 }) -> DaySummary[]`

Settled days, newest first, at most `min(limit, 64)` (the contract keeps the last 64).

| Field | Type | Meaning |
|---|---|---|
| `day` | u32 | Day number |
| `outcome` | `"Success"` \| `"Fail"` \| `"Idle"` | Result |
| `goal`, `count` | u32 | Goal and check-ins |
| `streak_after` | u32 | Community streak after the day |
| `per_share` | U128 | Reward per checked-in member (Success) |
| `jackpot` | U128 | Jackpot set aside for the hero; 0 if none |
| `hero` | string \| null | Winner, filled in by the draw a block or two after settle |
| `pot_burned`, `stake_slashed` | U128 | Burnt from the pot and from stakes (Fail) |
| `pot_after` | U128 | Pot after the day |

Outcomes: **Success** when `goal > 0` and `count ≥ goal` (streak +1, rewards, jackpot). Shares
of members who checked in and then left that day stay in the pot; no jackpot is set aside when
there are no closers or `per_share` is 0. **Fail** otherwise: the
streak resets, `burn_bps` of the pot burns and members who missed the day lose `slash_bps` of their
stake. **Idle** when the goal is 0 (fewer than `min_goal` active members) or everyone left: nothing
changes and the streak is kept.

### `get_kickable({ from_index: u32, limit: u32 }) -> KickablePage`

Returns `{ accounts: string[], next_index: u32 | null }`: kickable members among member indexes
`[from_index, from_index + limit)`. A page may be empty while `next_index` is not null; keep paging
until it is null. Page by 100–200. Indexes shift after a leave or kick, so treat the list as a hint
and expect `ERR_NOT_MEMBER` or `ERR_NOT_INACTIVE` on a stale entry. `limit: 0` returns an empty
page with `next_index: null`.

### `get_config() -> ConfigView`

Every field of [Parameters](#parameters) plus `pot_bps`, `faucet_bps`, `initial_supply` (U128),
`launch_ns` (U64 string), `auto_settle_cap` (50), `max_settle_days` (500), `history_len` (64).

## Token and storage standards

The contract is also the `$LAST` token: NEP-141 (fungible token), NEP-145 (storage management),
NEP-148 (metadata), NEP-330 (`contract_source_metadata`). The behaviour is the
near-contract-standards implementation, with these differences:

- `ft_transfer` and `ft_transfer_call` to the contract itself fail with `ERR_USE_JOIN`.
- A member cannot `storage_unregister`: `ERR_MEMBER_CANNOT_UNREGISTER` (leave first).
- `storage_unregister({force: true})` with a non-zero balance burns that balance and emits
  `ft_burn` with memo `"unregister"`.
- The contract does not accept tokens (`ft_on_transfer` is not implemented).

| Method | Kind | Deposit | Returns |
|---|---|---|---|
| `ft_transfer({receiver_id, amount, memo})` | change | 1 yocto | nothing |
| `ft_transfer_call({receiver_id, amount, memo, msg})` | change | 1 yocto | `U128` amount used |
| `ft_balance_of({account_id})` | view | — | `U128` |
| `ft_total_supply()` | view | — | `U128` |
| `ft_metadata()` | view | — | `{spec, name, symbol, icon, reference, reference_hash, decimals}` |
| `storage_deposit({account_id, registration_only})` | change | ≥ `storage_balance_bounds().min` | `{total, available}` |
| `storage_withdraw({amount})` | change | 1 yocto | `{total, available}` |
| `storage_unregister({force})` | change | 1 yocto | `bool` |
| `storage_balance_of({account_id})` | view | — | `{total, available}` \| `null` |
| `storage_balance_bounds()` | view | — | `{min, max}` |
| `contract_source_metadata()` | view | — | NEP-330 metadata |

Token registration (`storage_deposit`) and game membership (`join`) are separate: a member must be
registered, and a registered account need not be a member.

## Events

Game events, `EVENT_JSON:{"standard":"lastcall","version":"1.0.0","event":"<name>","data":{...}}`
(amounts are U128 strings):

| Event | Data | Emitted by |
|---|---|---|
| `join` | `{account_id, stake, activation_day}` | `join` |
| `check_in` | `{account_id, day, n, goal, in_closers, via: "direct" \| "signed"}` | `check_in`, `check_in_signed` |
| `days_settled` | `{runs: [{from_day, to_day, outcome, goal, count, streak_after, per_share, jackpot, pot_burned, stake_slashed, pot_after}]}` | any call that settles days |
| `hero` | `{day, account_id, jackpot, paid}` | the hero draw receipt |
| `claim` | `{account_id, amount}` | `claim` |
| `leave` | `{account_id, returned, fee_burned}` | `leave` |
| `kick` | `{account_id, by, returned, fee_burned, bounty}` | `kick` |
| `faucet` | `{account_id, amount}` | `faucet` |

Notes:

- `days_settled` comes once per settling call. Consecutive empty days (`count == 0`) with the same
  `outcome` and `goal` merge into one run: `pot_burned` and `stake_slashed` are summed,
  `streak_after` and `pot_after` are those of the run's last day. `jackpot` is what was actually
  set aside (0 when nobody was a closer).
- `hero.paid` is false when the winner has no token account; the jackpot then returns to the pot.
- `returned` in `leave`/`kick` is `stake − fee`; claimable rewards are paid in the same
  `ft_transfer`, whose amount is the full payout.

Token events (`"standard":"nep141","version":"1.0.0"`, `data` is an array): `ft_mint` once at deploy;
`ft_transfer` for every token movement (join stake, claim, exit payout, bounty, jackpot, faucet,
user transfers); `ft_burn` for burns (settle: one entry with memo `"days <from>..<to>"`;
leave/kick fee: no memo; forced unregister: memo `"unregister"`; `ft_resolve_transfer` burns the
refund with the standard library's own log when the sender unregistered while an
`ft_transfer_call` was in flight). `ft_mint` at deploy has memo `"launch"` and up to two entries
(the contract and `initial_holder`).

Log order: settling logs come first — `ft_burn`, then `days_settled` — followed by the method's
own logs. For example, a `claim` that settles days logs `ft_burn`, `days_settled`, `ft_transfer`,
`claim`; inside `leave` and `kick` the fee `ft_burn` comes before the transfers and the game event.

## Errors

| Error | When |
|---|---|
| `ERR_NOT_MEMBER` | The caller (or the kick target, or `account_id` in `check_in_signed`) is not a member |
| `ERR_ALREADY_MEMBER` | `join` by a member |
| `ERR_WARMUP` | Check-in before `activation_day` |
| `ERR_ALREADY_CHECKED_IN` | Second check-in on the same day |
| `ERR_BACKLOG` | More than `auto_settle_cap` days pending; call `settle` first |
| `ERR_LOW_GAS` | Not enough gas left to schedule the hero draw; resend with more gas |
| `ERR_NOT_REGISTERED` | `join` or `faucet` by an account without a token account |
| `ERR_INSUFFICIENT_BALANCE` | `join` with fewer than `join_stake` LAST |
| `ERR_STORAGE_DEPOSIT` | `join` with less than `member_storage_deposit` attached |
| `ERR_NOTHING_TO_CLAIM` | `claim` with nothing claimable |
| `ERR_ONE_YOCTO` | `set_checkin_key`, `claim` or `leave` without exactly 1 yoctoNEAR |
| `ERR_FAUCET_DISABLED` | `faucet` when `faucet_amount` is 0 |
| `ERR_FAUCET_USED` | Second `faucet` by the same account |
| `ERR_FAUCET_EMPTY` | Faucet has fewer than `faucet_amount` left |
| `ERR_MEMBER_CANNOT_UNREGISTER` | `storage_unregister` by a member |
| `ERR_USE_JOIN` | Token transfer to the contract itself |
| `ERR_BAD_CONFIG` | Invalid `new` parameters (deploy only) |
| `ERR_NO_CHECKIN_KEY` | `check_in_signed` for a member without `checkin_key` |
| `ERR_BAD_SIGNATURE` | Wrong nonce or signature length, or the signature does not verify |
| `ERR_BAD_DAY` | `check_in_signed` with `day ≠ today` |
| `ERR_BAD_KEY` | `checkin_key` is not an ed25519 key |
| `ERR_NOT_INACTIVE` | `kick` before `kickable_from_day`, or of a member in warm-up |
| `ERR_NO_PENDING_HERO` | `retry_pick_hero` for a day without a pending draw |

`ERR_ONE_YOCTO`, `ERR_BACKLOG` and `ERR_LOW_GAS` are checked before any work, so the call changes
nothing. Every failed call is rolled back in full.

## Signed check-in payload (NEP-413)

The signature covers `sha256` of this borsh serialization (little-endian):

| Field | Type | Value |
|---|---|---|
| tag | `u32` | `2147484061` (2³¹ + 413) |
| message | string (`u32` length + UTF-8) | `{"action":"check_in","account_id":"<account_id>","day":<day>}` exactly, no spaces |
| nonce | `[u8; 32]` | the 32 nonce bytes, **without** a length prefix |
| recipient | string | the contract account id |
| callback_url | `Option<string>` | `None`: one byte `0x00` |

The contract checks `ed25519_verify(signature, sha256(payload), checkin_key)`. The nonce is not
stored; any 32 random bytes work. `contract/tests/fixtures/nep413.json` holds a key, valid cases
and rejected cases that the TypeScript implementation must reproduce byte for byte.

## Limits

- Check-ins count staked seats, not people.
- The block producer can influence `random_seed`, which picks the hero.
- A relayer can withhold or reorder signed check-ins; direct `check_in` always works.
- Among several check-ins in one block, only the first can become a closer.
- A member who checks in once every `inactive_days` days cannot be kicked. A self-kick costs less
  than `leave` by the bounty.
- A member who has not touched the contract for a very long time pays more gas on the next call
  (≈ 0.07 Tgas per 64 days of absence); on the demo set (60 s days) about 200 real days reach the
  gas limit.
- The deployed contract has no access keys: nobody can upgrade it or change its parameters.
