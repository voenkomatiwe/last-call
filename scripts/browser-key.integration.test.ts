import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Account, actions, PublicKey } from "near-api-js";
import {
  AccessKeyDepositWithFunctionCallActionError,
  AccessKeyMethodNameMismatchActionError,
  AccessKeyReceiverMismatchActionError,
} from "near-api-js/rpc-errors";

import {
  checkinKeyStatus,
  enableCheckinKeyActions,
  isAllowanceExhausted,
  KEY_ALLOWANCE,
  keyCheckInCall,
} from "../web/src/checkin/access-key";
import { generateCheckinKey, publicKeyString } from "../web/src/checkin/browser-key";
import { WebCryptoSigner } from "../web/src/checkin/webcrypto-signer";
import { type ContractCall, faucetCall, joinCall, storageDepositCall } from "../web/src/contract/calls";
import { parseCheckInResult } from "../web/src/contract/views";
import { type Deployment, LocalChain, type TestAccount } from "./sandbox";

// One-tap check-in with a browser key (plan decision "12.11 (поздно ночью)"): the member adds a
// check_in-only function-call key to their own account; the page signs with a non-extractable
// WebCrypto key and the member's account pays the gas. Opt-in:
//   LAST_CALL_SANDBOX=1 bun test scripts/browser-key.integration.test.ts

const enabled = process.env.LAST_CALL_SANDBOX === "1";

describe.skipIf(!enabled)("a check_in-only browser key on the real contract", () => {
  let chain: LocalChain;
  let game: Deployment;
  let player: TestAccount;
  let keyed: Account;
  let publicKey: string;

  async function send(who: Account, call: ContractCall): Promise<unknown> {
    return who.callFunction({
      contractId: game.contractId,
      methodName: call.methodName,
      args: call.args,
      gas: BigInt(call.gas),
      deposit: BigInt(call.deposit),
    });
  }

  beforeAll(async () => {
    chain = await LocalChain.start();
    game = await chain.deploy("lastcall", "demo");
    const config = await game.reader.config();
    const bounds = await game.reader.storageBalanceBounds();
    const players: TestAccount[] = [];
    for (const name of ["player", "other-1", "other-2"]) {
      const p = await chain.createAccount(name);
      await send(p.account, storageDepositCall(bounds.min));
      await send(p.account, faucetCall());
      await send(p.account, joinCall(config.memberStorageDeposit));
      players.push(p);
    }
    player = players[0] as TestAccount;
    const pair = await generateCheckinKey();
    publicKey = await publicKeyString(pair);
    keyed = new Account(player.accountId, chain.provider, new WebCryptoSigner(pair));
  }, 300_000);

  afterAll(async () => {
    await chain?.stop();
  });

  test("the key is missing until the member adds it, then ready", async () => {
    expect(await checkinKeyStatus(chain.provider, player.accountId, publicKey, game.contractId)).toBe("missing");
    // What the wallet sends on "Enable one-tap check-in": AddKey to the member's own account.
    await player.account.signAndSendTransaction({
      receiverId: player.accountId,
      actions: [
        actions.addFunctionCallAccessKey(PublicKey.from(publicKey), game.contractId, ["check_in"], KEY_ALLOWANCE),
      ],
    });
    expect(await checkinKeyStatus(chain.provider, player.accountId, publicKey, game.contractId)).toBe("ready");
    expect(await checkinKeyStatus(chain.provider, player.accountId, player.publicKey, game.contractId)).toBe(
      "wrong-permission"
    );
  }, 120_000);

  test("a check-in signed by the browser key succeeds and the member's account pays the gas", async () => {
    const today = await chain.goToDay(game, 1);
    const before = await chain.provider.viewAccount({ accountId: player.accountId });
    const result = parseCheckInResult(await send(keyed, keyCheckInCall()));
    expect(result).toMatchObject({ day: today, n: 1 });
    expect((await game.reader.member(player.accountId))?.checkedInToday).toBe(true);
    const after = await chain.provider.viewAccount({ accountId: player.accountId });
    expect(BigInt(after.amount)).toBeLessThan(BigInt(before.amount)); // gas came from the player
  }, 120_000);

  /** The error a call with the browser key fails with (the call must fail). */
  async function failure(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to fail");
  }

  test("the key cannot call anything else, for the right reason", async () => {
    const fc =
      (method: string, args: object, deposit = 0n, receiver = game.contractId) =>
      () =>
        keyed.signAndSendTransaction({
          receiverId: receiver,
          actions: [actions.functionCall(method, args, 50n * 10n ** 12n, deposit)],
        });
    // Any deposit is refused for a function-call key: no claim (1 yocto), no ft_transfer.
    expect(await failure(fc("claim", {}, 1n))).toBeInstanceOf(AccessKeyDepositWithFunctionCallActionError);
    expect(await failure(fc("ft_transfer", { receiver_id: game.holder.accountId, amount: "1" }, 1n))).toBeInstanceOf(
      AccessKeyDepositWithFunctionCallActionError
    );
    // Other methods of the same contract.
    expect(await failure(fc("leave", {}))).toBeInstanceOf(AccessKeyMethodNameMismatchActionError);
    expect(await failure(fc("settle", { max_days: null }))).toBeInstanceOf(AccessKeyMethodNameMismatchActionError);
    // Another receiver.
    expect(await failure(fc("check_in", {}, 0n, game.holder.accountId))).toBeInstanceOf(
      AccessKeyReceiverMismatchActionError
    );
  }, 120_000);

  test("a used-up allowance is recognised, and re-enabling replaces the key in one transaction", async () => {
    // A key with an allowance too small for one 50 Tgas call.
    const small = await generateCheckinKey();
    const smallKey = await publicKeyString(small);
    await player.account.signAndSendTransaction({
      receiverId: player.accountId,
      actions: [actions.addFunctionCallAccessKey(PublicKey.from(smallKey), game.contractId, ["check_in"], 1n)],
    });
    const poor = new Account(player.accountId, chain.provider, new WebCryptoSigner(small));
    expect(isAllowanceExhausted(await failure(() => send(poor, keyCheckInCall())))).toBe(true);

    // What "Enable one-tap check-in" sends after that: DeleteKey(old) + AddKey(new), one transaction.
    const fresh = await generateCheckinKey();
    const freshKey = await publicKeyString(fresh);
    const replace = enableCheckinKeyActions(game.contractId, freshKey, smallKey);
    expect(replace.map((action) => action.type)).toEqual(["DeleteKey", "AddKey"]);
    await player.account.signAndSendTransaction({
      receiverId: player.accountId,
      actions: [
        actions.deleteKey(PublicKey.from(smallKey)),
        actions.addFunctionCallAccessKey(PublicKey.from(freshKey), game.contractId, ["check_in"], KEY_ALLOWANCE),
      ],
    });
    expect(await checkinKeyStatus(chain.provider, player.accountId, smallKey, game.contractId)).toBe("missing");
    expect(await checkinKeyStatus(chain.provider, player.accountId, freshKey, game.contractId)).toBe("ready");
  }, 120_000);
});
