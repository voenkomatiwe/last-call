import {
  type ContractCall,
  checkInCall,
  faucetCall,
  joinCall,
  settleCall,
  storageDepositCall,
} from "../web/src/contract/calls";
import { describeContractError } from "../web/src/contract/errors";
import type { DaySummary } from "../web/src/contract/views";
import { formatLast } from "../web/src/game/format";
import { type FinalRow, formatDay, formatTable, shortName } from "./demo-report";
import { type Deployment, LocalChain, type TestAccount } from "./sandbox";

// `bun run demo` (plan 6.3, kill-switch K4): the committed wasm in a local sandbox with the demo set
// (60 s days), 8 bots and `you`, the contract's keys deleted, then six days played with
// fast-forward. Nothing here needs a wallet or the internet beyond the first sandbox download.

/** Check-ins per day out of 9 members; the demo goal is max(3, ceil(9 × 0.6)) = 6. Day 3 fails. */
const DAY_PLAN = [9, 7, 3, 6, 8, 9] as const;
const BOTS = 8;

function step(text: string): void {
  console.log(`\n▸ ${text}`);
}

async function send(game: Deployment, who: TestAccount, call: ContractCall): Promise<unknown> {
  try {
    return await who.account.callFunction({
      contractId: game.contractId,
      methodName: call.methodName,
      args: call.args,
      gas: BigInt(call.gas),
      deposit: BigInt(call.deposit),
    });
  } catch (error) {
    throw new Error(`${shortName(who.accountId)} ${call.methodName}: ${describeContractError(error)}`);
  }
}

/** Waits until every scheduled hero draw has run (a block or two after settle). */
async function waitForHeroes(game: Deployment): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await game.reader.state()).pendingHeroDays.length === 0) return;
    await Bun.sleep(250);
  }
  throw new Error("the hero draw did not run within 10 s");
}

async function run(chain: LocalChain): Promise<void> {
  step("Deploying contract/res/last_call.wasm (sha256 checked) with the demo set");
  const game = await chain.deploy("lastcall", "demo");
  const config = await game.reader.config();
  console.log(
    `  ${game.contractId}: day ${config.dayLengthS} s, stake ${formatLast(config.joinStake)}, faucet ${formatLast(config.faucetAmount)}, closers ${config.closersK}`
  );

  step(`Creating ${BOTS} bots and you; each registers, takes the faucet, and joins`);
  const players: TestAccount[] = [];
  const bounds = await game.reader.storageBalanceBounds();
  for (const name of [...Array.from({ length: BOTS }, (_, index) => `bot-${index + 1}`), "you"]) {
    const player = await chain.createAccount(name);
    await send(game, player, storageDepositCall(bounds.min));
    await send(game, player, faucetCall());
    await send(game, player, joinCall(config.memberStorageDeposit));
    players.push(player);
  }
  console.log(`  ${players.length} members, active from day ${config.warmupDays}`);

  step("Deleting the contract's access keys");
  await game.contract.account.deleteKey(game.contract.publicKey);
  const keys = await game.contract.account.getAccessKeyList();
  console.log(`  list-keys ${game.contractId}: ${keys.keys.length === 0 ? "(empty)" : JSON.stringify(keys.keys)}`);
  if (keys.keys.length !== 0) throw new Error("the contract still has access keys");
  console.log("  Nobody can upgrade it or change its parameters now. The game keeps running:");

  const you = players.at(-1) as TestAccount;
  const summaries: DaySummary[] = [];
  for (const [index, count] of DAY_PLAN.entries()) {
    const day = index + 1;
    const today = await chain.goToDay(game, day);
    if (today !== day) throw new Error(`fast-forward landed on day ${today}, not ${day}`);
    // A different starting member each day, so different accounts end up as closers.
    const order = players.map((_, position) => players[(position + index * 2) % players.length] as TestAccount);
    for (const player of order.slice(0, count)) await send(game, player, checkInCall());
    const closers = (await game.reader.openDay()).closers;

    await chain.goToDay(game, day + 1);
    // Anyone may settle; here `you` does it, with the contract's keys already gone.
    await send(game, you, settleCall());
    await waitForHeroes(game);
    const [summary] = await game.reader.history(1);
    if (summary?.day !== day) throw new Error(`expected the summary of day ${day}`);
    // The demo checks its own plan: a day that ended during the check-ins would change the story.
    if (summary.count !== count) throw new Error(`day ${day}: ${summary.count} check-ins, planned ${count}`);
    summaries.push(summary);
    console.log(`  ${formatDay(summary, closers)}`);
  }
  if (!summaries.some((day) => day.outcome === "Success" && day.hero !== null)) {
    throw new Error("the demo produced no successful day with a hero");
  }
  if (!summaries.some((day) => day.outcome === "Fail" && day.potBurned > 0n)) {
    throw new Error("the demo produced no failed day with a burn");
  }

  step("Final state");
  const state = await game.reader.state();
  const rows: FinalRow[] = [];
  for (const player of players) {
    const member = await game.reader.member(player.accountId);
    rows.push({
      name: shortName(player.accountId),
      balance: await game.reader.balance(player.accountId),
      stake: member?.effectiveStake ?? 0n,
      claimable: member?.pendingClaimable ?? 0n,
      checkins: member?.checkins ?? 0,
      heroCount: member?.heroCount ?? 0,
    });
  }
  console.log(formatTable(rows));
  console.log(
    `\n  pot ${formatLast(state.pot)} · supply ${formatLast(state.totalSupply)} · burnt ${formatLast(state.totalBurned)} · rewarded ${formatLast(state.totalRewarded)} · jackpots ${formatLast(state.totalJackpots)} · streak ${state.streak} (record ${state.longestStreak})`
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--auto";
  if (mode !== "--auto") {
    console.error(`Unknown mode ${mode}. Usage: bun run demo [--auto]`);
    process.exit(2);
  }
  const started = Date.now();
  let chain: LocalChain | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= chain ? chain.stop() : Promise.resolve();
    return stopping;
  };
  // Installed before the node starts. A signal during start only sets the flag: exiting then would
  // orphan the node that is still being spawned, so main stops it as soon as start returns.
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    console.log("\nInterrupted: stopping the sandbox…");
    if (chain) stop().finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  step("Starting a local NEAR sandbox (the first run downloads the node, ~73 MB)");
  chain = await LocalChain.start();
  if (interrupted) {
    await stop();
    process.exit(130);
  }
  try {
    await run(chain);
    console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s.`);
  } finally {
    await stop();
  }
}

/** Set on Ctrl-C or SIGTERM: calls cut off by the stopping node then fail, which is expected. */
let interrupted = false;

main().catch((error) => {
  if (interrupted) return;
  console.error(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
