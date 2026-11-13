import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Account, KeyPair, type KeyPairString } from "near-api-js";

import {
  type ContractCall,
  checkInCall,
  claimCall,
  joinCall,
  settleCall,
  storageDepositCall,
} from "../web/src/contract/calls";
import { describeContractError } from "../web/src/contract/errors";
import { ContractReader } from "../web/src/contract/reader";
import { formatLast, formatNear } from "../web/src/game/format";
import { DEFAULT_RPC_URLS } from "../web/src/near/near-config";
import { createViewProvider } from "../web/src/near/view";

// Testnet bots (LC-030): a few accounts that play `v1.last-call.testnet` next to the user's wallet,
// so real days have a goal, closers, a hero and rewards. Keys live only in the gitignored root `.env`
// (Bun loads it); this script never prints them and never passes them on a command line.
//
//   bun scripts/testnet-bots.ts create 6     new accounts funded by the testnet faucet service
//   bun scripts/testnet-bots.ts status       NEAR, LAST, membership of every bot
//   bun scripts/testnet-bots.ts register     token storage for bots that lack it (to receive LAST)
//   bun scripts/testnet-bots.ts join         join with the stake, for registered bots holding enough LAST
//   bun scripts/testnet-bots.ts check-in 3   the first N bots that can check in today do it
//   bun scripts/testnet-bots.ts settle       settle finished days (and draw heroes)
//   bun scripts/testnet-bots.ts claim        bots with rewards claim them

const ROOT = join(import.meta.dir, "..");
const ENV_FILE = join(ROOT, ".env");
const CONTRACT_ID = process.env.LC_CONTRACT_ID ?? "v1.last-call.testnet";
/** Several public testnet RPCs, tried in order (`DEFAULT_RPC_URLS`); `LC_TESTNET_RPC` overrides, comma-separated. */
const RPC_URL = process.env.LC_TESTNET_RPC ?? DEFAULT_RPC_URLS.testnet;

interface Bot {
  readonly index: number;
  readonly accountId: string;
  readonly account: Account;
}

const provider = createViewProvider(RPC_URL);
const reader = new ContractReader(provider, CONTRACT_ID);

/** `LC_BOT_<n>_ID` / `LC_BOT_<n>_KEY` pairs from the environment, in order. */
function loadBots(): Bot[] {
  const bots: Bot[] = [];
  for (let i = 1; ; i++) {
    const id = process.env[`LC_BOT_${i}_ID`];
    const key = process.env[`LC_BOT_${i}_KEY`];
    if (!id || !key) break;
    bots.push({ index: i, accountId: id, account: new Account(id, provider, key as KeyPairString) });
  }
  return bots;
}

async function send(bot: Bot, call: ContractCall): Promise<unknown> {
  try {
    return await bot.account.callFunction({
      contractId: CONTRACT_ID,
      methodName: call.methodName,
      args: call.args,
      gas: BigInt(call.gas),
      deposit: BigInt(call.deposit),
    });
  } catch (error) {
    throw new Error(`${bot.accountId} ${call.methodName}: ${describeContractError(error)}`);
  }
}

async function nearBalance(accountId: string): Promise<bigint | null> {
  try {
    const view = await provider.viewAccount({ accountId });
    return BigInt(view.amount);
  } catch {
    return null;
  }
}

/** Appends one bot to `.env` (created with mode 600). */
async function saveBot(index: number, accountId: string, secret: string): Promise<void> {
  const file = Bun.file(ENV_FILE);
  const before = (await file.exists()) ? await file.text() : "";
  const head = before === "" ? "# Testnet bot keys (LC-030). Secret: never commit, never paste anywhere.\n" : "";
  const sep = before === "" || before.endsWith("\n") ? "" : "\n";
  await Bun.write(ENV_FILE, `${before}${sep}${head}LC_BOT_${index}_ID=${accountId}\nLC_BOT_${index}_KEY=${secret}\n`);
  await chmod(ENV_FILE, 0o600);
}

async function create(count: number): Promise<void> {
  const existing = loadBots().length;
  const tag = crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36).slice(0, 5) ?? "x";
  for (let n = 1; n <= count; n++) {
    const index = existing + n;
    const accountId = `lastcall-bot-${tag}-${index}.testnet`;
    const keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();
    // Only the public key goes on the command line; the faucet service creates and funds the account.
    const result =
      await Bun.$`near account create-account sponsor-by-faucet-service ${accountId} use-manually-provided-public-key ${publicKey} network-config testnet create`
        .quiet()
        .nothrow();
    if (result.exitCode !== 0) {
      console.error(`✗ ${accountId}: faucet service refused (exit ${result.exitCode})`);
      console.error(result.stderr.toString().trim().split("\n").slice(-3).join("\n"));
      break;
    }
    await saveBot(index, accountId, keyPair.toString());
    console.log(`✓ ${accountId} created; key saved to .env as LC_BOT_${index}_*`);
  }
}

async function status(): Promise<void> {
  const [bots, config] = [loadBots(), await reader.config()];
  console.log(`contract ${CONTRACT_ID}, stake ${formatLast(config.joinStake)}, ${bots.length} bot(s)`);
  for (const bot of bots) {
    const [near, storage, balance, member] = await Promise.all([
      nearBalance(bot.accountId),
      reader.storageBalance(bot.accountId),
      reader.balance(bot.accountId).catch(() => 0n),
      reader.member(bot.accountId),
    ]);
    const role = member
      ? `member: ${member.isActive ? "active" : `warm-up until day ${member.activationDay}`}, ` +
        `checked in today: ${member.checkedInToday ? "yes" : "no"}, to claim ${formatLast(member.pendingClaimable)}`
      : storage
        ? "registered, not a member"
        : "not registered for the token";
    console.log(
      `${bot.index}. ${bot.accountId}  ${near === null ? "no account" : formatNear(near)}  ${formatLast(balance)}  ${role}`
    );
  }
}

async function register(): Promise<void> {
  const bounds = await reader.storageBalanceBounds();
  for (const bot of loadBots()) {
    if (await reader.storageBalance(bot.accountId)) continue;
    await send(bot, storageDepositCall(bounds.min));
    console.log(`✓ ${bot.accountId} registered for the token`);
  }
}

async function joinAll(): Promise<void> {
  const config = await reader.config();
  for (const bot of loadBots()) {
    if (await reader.member(bot.accountId)) continue;
    const balance = await reader.balance(bot.accountId).catch(() => 0n);
    if (balance < config.joinStake) {
      console.log(`· ${bot.accountId}: ${formatLast(balance)}, needs ${formatLast(config.joinStake)} to join`);
      continue;
    }
    await send(bot, joinCall(config.memberStorageDeposit));
    console.log(`✓ ${bot.accountId} joined`);
  }
}

async function checkIn(limit: number): Promise<void> {
  let done = 0;
  for (const bot of loadBots()) {
    if (done >= limit) break;
    const member = await reader.member(bot.accountId);
    if (!member?.canCheckInToday) continue;
    const result = (await send(bot, checkInCall())) as { n?: number; goal?: number; in_closers?: boolean };
    done++;
    console.log(
      `✓ ${bot.accountId} checked in: #${result.n} of goal ${result.goal}${result.in_closers ? ", closer" : ""}`
    );
  }
  if (done < limit) console.log(`· only ${done} bot(s) could check in today`);
}

async function settle(): Promise<void> {
  const [bot] = loadBots();
  if (!bot) throw new Error("No bots in .env");
  await send(bot, settleCall());
  console.log(`✓ settled by ${bot.accountId}`);
}

async function claim(): Promise<void> {
  for (const bot of loadBots()) {
    const member = await reader.member(bot.accountId);
    if (!member || member.pendingClaimable === 0n) continue;
    const paid = await send(bot, claimCall());
    console.log(`✓ ${bot.accountId} claimed ${formatLast(BigInt(String(paid)))}`);
  }
}

const [command, arg] = process.argv.slice(2);
const count = Number(arg ?? "1");
switch (command) {
  case "create":
    await create(Number.isInteger(count) && count > 0 && count <= 10 ? count : 1);
    break;
  case "status":
    await status();
    break;
  case "register":
    await register();
    break;
  case "join":
    await joinAll();
    break;
  case "check-in":
    await checkIn(Number.isInteger(count) && count > 0 ? count : 1);
    break;
  case "settle":
    await settle();
    break;
  case "claim":
    await claim();
    break;
  default:
    console.log("usage: bun scripts/testnet-bots.ts create N | status | register | join | check-in N | settle | claim");
}
