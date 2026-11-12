import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";

import { checkInPayload, createNonce, hashNep413Payload } from "../web/src/checkin/nep413";
import { type ContractCall, faucetCall, joinCall, storageDepositCall } from "../web/src/contract/calls";
import { bytesToBase64 } from "../web/src/near/encoding";
import { type CheckInGateway, CheckInRelayer, type CheckInSubmission } from "../web/src/relayer/check-in-relayer";
import { NearCheckInGateway } from "../web/src/relayer/near-gateway";
import { type Deployment, LocalChain, type TestAccount } from "./sandbox";

// Signed check-ins through the relayer to the real wasm (plan 4.10). Opt-in:
//   LAST_CALL_SANDBOX=1 bun test scripts/relayer.integration.test.ts

const enabled = process.env.LAST_CALL_SANDBOX === "1";

describe.skipIf(!enabled)("the relayer on the real contract", () => {
  let chain: LocalChain;
  let game: Deployment;
  let relayer: CheckInRelayer;
  const settleFirst: boolean[] = [];
  const checkinKey = KeyPair.fromRandom("ed25519");
  const late = KeyPair.fromRandom("ed25519");
  let keyed: TestAccount;
  let keyless: TestAccount;
  let warming: TestAccount;

  async function send(who: TestAccount, call: ContractCall): Promise<unknown> {
    return who.account.callFunction({
      contractId: game.contractId,
      methodName: call.methodName,
      args: call.args,
      gas: BigInt(call.gas),
      deposit: BigInt(call.deposit),
    });
  }

  async function member(name: string, key: string | null): Promise<TestAccount> {
    const player = await chain.createAccount(name);
    const config = await game.reader.config();
    await send(player, storageDepositCall((await game.reader.storageBalanceBounds()).min));
    await send(player, faucetCall());
    await send(player, joinCall(config.memberStorageDeposit, key));
    return player;
  }

  /** The body the page would POST: a NEP-413 signature by `signer` over the check-in for `day`. */
  async function signedBody(accountId: string, day: number, signer: KeyPair) {
    const nonce = createNonce();
    const hash = await hashNep413Payload(checkInPayload({ accountId, day, nonce, contractId: game.contractId }));
    return {
      account_id: accountId,
      day,
      nonce: bytesToBase64(nonce),
      signature: bytesToBase64(signer.sign(hash).signature),
    };
  }

  beforeAll(async () => {
    chain = await LocalChain.start();
    game = await chain.deploy("lastcall", "demo");
    keyed = await member("keyed", checkinKey.getPublicKey().toString());
    keyless = await member("keyless", null);
    await member("filler", null); // three members: goal 3 from day 1
    const relayerAccount = await chain.createAccount("relayer");
    const gateway = new NearCheckInGateway(game.reader, relayerAccount.account);
    // Records whether each submission settled first, and otherwise passes everything through.
    const spy: CheckInGateway = {
      contractId: gateway.contractId,
      getToday: () => gateway.getToday(),
      getCheckinKey: (accountId) => gateway.getCheckinKey(accountId),
      submitCheckIn: (submission: CheckInSubmission) => {
        settleFirst.push(submission.settleFirst);
        return gateway.submitCheckIn(submission);
      },
    };
    relayer = new CheckInRelayer(spy);
  }, 300_000);

  afterAll(async () => {
    await chain?.stop();
  });

  test("a signed check-in reaches the chain and the result matches it", async () => {
    const today = await chain.goToDay(game, 1);
    const outcome = await relayer.relay(await signedBody(keyed.accountId, today, checkinKey));
    expect(outcome).toEqual({ ok: true, result: { day: today, n: 1, goal: 3, in_closers: true } });
    const view = await game.reader.member(keyed.accountId);
    expect(view?.checkedInToday).toBe(true);
    expect((await game.reader.openDay()).closers).toEqual([keyed.accountId]);
    expect(settleFirst).toEqual([false]);
  }, 120_000);

  test("refusals the backend sees itself, and a repeat", async () => {
    const today = (await game.reader.state()).today;
    const again = await relayer.relay(await signedBody(keyed.accountId, today, checkinKey));
    expect(again).toMatchObject({ ok: false, code: "ALREADY_SUBMITTED" });
    const noKey = await relayer.relay(await signedBody(keyless.accountId, today, checkinKey));
    expect(noKey).toMatchObject({ ok: false, code: "ERR_NO_CHECKIN_KEY" });
    const wrongDay = await relayer.relay(await signedBody(keyed.accountId, today + 1, checkinKey));
    expect(wrongDay).toMatchObject({ ok: false, code: "ERR_BAD_DAY", today });
  }, 120_000);

  test("the contract's own refusal surfaces as its ERR_ code", async () => {
    warming = await member("warming", late.getPublicKey().toString()); // joins today: in warm-up
    const today = (await game.reader.state()).today;
    const outcome = await relayer.relay(await signedBody(warming.accountId, today, late));
    expect(outcome).toMatchObject({ ok: false, code: "CONTRACT_ERROR", contractCode: "ERR_WARMUP" });
  }, 120_000);

  test("with more than auto_settle_cap days pending it settles and checks in in one transaction", async () => {
    const cap = (await game.reader.config()).autoSettleCap;
    const before = (await game.reader.state()).today;
    const today = await chain.goToDay(game, before + cap + 2);
    expect((await game.reader.state()).pendingDays).toBeGreaterThan(cap);
    settleFirst.length = 0;
    const outcome = await relayer.relay(await signedBody(keyed.accountId, today, checkinKey));
    expect(outcome).toMatchObject({ ok: true, result: { day: today, n: 1 } });
    expect(settleFirst).toEqual([false, true]); // refused with ERR_BACKLOG, then settle-first
    expect((await game.reader.state()).pendingDays).toBe(0);
  }, 300_000);
});
