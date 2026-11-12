import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { checkInCall, joinCall, storageDepositCall } from "../web/src/contract/calls";
import { parseCheckInResult } from "../web/src/contract/views";
import { type Deployment, LocalChain, type TestAccount } from "./sandbox";

// Plays one successful day on the real wasm in a local sandbox. Opt-in because the first run
// downloads the sandbox binary (~73 MB) and a run takes about a minute:
//   LAST_CALL_SANDBOX=1 bun test scripts/sandbox.integration.test.ts

const enabled = process.env.LAST_CALL_SANDBOX === "1";
const LAST = 10n ** 18n;

describe.skipIf(!enabled)("the real contract in a local sandbox", () => {
  let chain: LocalChain;
  let game: Deployment;
  const players: TestAccount[] = [];

  beforeAll(async () => {
    chain = await LocalChain.start();
    game = await chain.deploy("lastcall", "demo");
  }, 300_000);

  afterAll(async () => {
    await chain?.stop();
  });

  /** Sends a call built by the page's call builders, from `who`, and returns the method's result. */
  async function send(who: TestAccount, call: ReturnType<typeof checkInCall>): Promise<unknown> {
    return who.account.callFunction({
      contractId: game.contractId,
      methodName: call.methodName,
      args: call.args,
      gas: BigInt(call.gas),
      deposit: BigInt(call.deposit),
    });
  }

  test("deploy: the views parse and match the demo set", async () => {
    const config = await game.reader.config();
    expect(config.dayLengthS).toBe(60);
    expect(config.closersK).toBe(5);
    const state = await game.reader.state();
    expect(state.today).toBe(0);
    expect(await game.reader.balance(game.holder.accountId)).toBeGreaterThan(0n);
  });

  test("join, warm up, check in, settle: a successful day with a hero", async () => {
    const config = await game.reader.config();
    const bounds = await game.reader.storageBalanceBounds();
    // Three members reach min_goal 3 on the demo set: goal max(3, ceil(3 × 0.6)) = 3.
    for (let index = 0; index < 3; index += 1) {
      const player = await chain.createAccount(`player-${index}`);
      players.push(player);
      await send(player, storageDepositCall(bounds.min));
      await game.holder.account.callFunction({
        contractId: game.contractId,
        methodName: "ft_transfer",
        args: { receiver_id: player.accountId, amount: (config.joinStake * 2n).toString() },
        gas: 30n * 10n ** 12n,
        deposit: 1n,
      });
      await send(player, joinCall(config.memberStorageDeposit));
    }
    expect((await game.reader.state()).membersTotal).toBe(3);

    const activation = (await game.reader.member(players[0]?.accountId ?? ""))?.activationDay ?? -1;
    await chain.goToDay(game, activation);
    const results = [];
    for (const player of players) results.push(parseCheckInResult(await send(player, checkInCall())));
    expect(results.map((result) => result.n)).toEqual([1, 2, 3]);
    expect(results[0]?.goal).toBe(3);
    // Separate transactions land in separate blocks here, so each is a closer.
    expect((await game.reader.openDay()).closers).toEqual(players.map((player) => player.accountId));

    await chain.goToDay(game, activation + 1);
    await game.holder.account.callFunction({
      contractId: game.contractId,
      methodName: "settle",
      args: { max_days: null },
      gas: 300n * 10n ** 12n,
    });
    // The hero is drawn in a separate receipt a block or two later.
    let day = (await game.reader.history(1))[0];
    for (let attempt = 0; attempt < 20 && !day?.hero; attempt += 1) {
      await Bun.sleep(500);
      day = (await game.reader.history(1))[0];
    }
    expect(day).toMatchObject({ day: activation, outcome: "Success", goal: 3, count: 3 });
    expect(day?.perShare ?? 0n).toBeGreaterThan(0n);
    expect(players.map((player) => player.accountId)).toContain(day?.hero ?? "none");

    const member = await game.reader.member(players[1]?.accountId ?? "");
    expect(member?.pendingClaimable).toBe(day?.perShare);
    expect((await game.reader.state()).streak).toBe(1);
    expect(config.joinStake).toBe(1000n * LAST);
  }, 300_000);
});
