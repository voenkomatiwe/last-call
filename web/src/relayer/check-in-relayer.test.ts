import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { base64ToBytes, bytesToBase64 } from "../near/encoding";
import { CheckInRelayer, type CheckInResult, ContractCallError, parseCheckInRequest } from "./check-in-relayer";
import { contractError, deferred, FakeGateway, otherPublicKey, signedRequest } from "./test-support";

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for a condition");
    await Bun.sleep(2);
  }
}

const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const CAROL = "carol.testnet";

function setup() {
  const gateway = new FakeGateway().member(ALICE).member(BOB).member(CAROL);
  return { gateway, relayer: new CheckInRelayer(gateway) };
}

describe("parseCheckInRequest", () => {
  test("accepts a well-formed request", async () => {
    const request = await signedRequest(ALICE, 7);
    expect(parseCheckInRequest(request)).toMatchObject({ accountId: ALICE, day: 7 });
  });

  test("rejects malformed requests", async () => {
    const valid = await signedRequest(ALICE, 7);
    const malformed: unknown[] = [
      null,
      "text",
      [],
      {},
      { ...valid, account_id: "Alice" },
      { ...valid, account_id: 1 },
      { ...valid, day: -1 },
      { ...valid, day: 1.5 },
      { ...valid, day: "7" },
      { ...valid, day: 2 ** 32 },
      { ...valid, nonce: bytesToBase64(new Uint8Array(31)) },
      { ...valid, nonce: "!!!" },
      { ...valid, signature: bytesToBase64(new Uint8Array(63)) },
      { ...valid, signature: undefined },
    ];
    for (const body of malformed) expect(parseCheckInRequest(body)).toBeUndefined();
  });
});

describe("CheckInRelayer refusals before submission", () => {
  test("a valid check-in reaches the gateway with canonical base64", async () => {
    const { gateway, relayer } = setup();
    const request = await signedRequest(ALICE, 7);

    expect(await relayer.relay(request)).toEqual({ ok: true, result: { day: 7, n: 1, goal: 5, in_closers: false } });
    expect(gateway.submissions).toEqual([
      { accountId: ALICE, day: 7, nonceBase64: request.nonce, signatureBase64: request.signature, settleFirst: false },
    ]);
  });

  test("non-canonical base64 is re-encoded before it is sent", async () => {
    const { gateway, relayer } = setup();
    const request = await signedRequest(ALICE, 7);
    const unpadded = { ...request, signature: request.signature.replace(/=+$/, "") };

    expect((await relayer.relay(unpadded)).ok).toBe(true);
    expect(gateway.submissions[0]?.signatureBase64).toBe(request.signature);
  });

  test("each refusal has its own code and sends nothing", async () => {
    const { gateway, relayer } = setup();
    gateway.keys.set("nokey.testnet", { kind: "no-key" });
    gateway.member("wrongkey.testnet", otherPublicKey());

    const cases: Array<[unknown, string]> = [
      [{ account_id: ALICE }, "INVALID_REQUEST"],
      [await signedRequest(ALICE, 6), "ERR_BAD_DAY"],
      [await signedRequest("stranger.testnet", 7), "ERR_NOT_MEMBER"],
      [await signedRequest("nokey.testnet", 7), "ERR_NO_CHECKIN_KEY"],
      [await signedRequest("wrongkey.testnet", 7), "ERR_BAD_SIGNATURE"],
      [await signedRequest(ALICE, 7, { recipient: "other.testnet" }), "ERR_BAD_SIGNATURE"],
      [{ ...(await signedRequest(ALICE, 7)), account_id: BOB }, "ERR_BAD_SIGNATURE"],
    ];
    for (const [body, code] of cases) {
      expect(await relayer.relay(body)).toMatchObject({ ok: false, code });
    }
    expect(gateway.submissions).toEqual([]);
  });

  test("a wrong day reports the contract's current day", async () => {
    const { relayer } = setup();
    expect(await relayer.relay(await signedRequest(ALICE, 8))).toMatchObject({ code: "ERR_BAD_DAY", today: 7 });
  });
});

describe("CheckInRelayer one submission per account and day", () => {
  test("refuses a second request while the first is pending, and after it succeeded", async () => {
    const { gateway, relayer } = setup();
    const pending = deferred<{ day: number; n: number; goal: number; in_closers: boolean }>();
    gateway.respond = () => pending.promise;
    // A second signature with a fresh nonce: a different request for the same check-in.
    const [firstRequest, secondRequest, thirdRequest] = await Promise.all([1, 2, 3].map(() => signedRequest(ALICE, 7)));

    const first = relayer.relay(firstRequest);
    await until(() => gateway.submissions.length === 1);
    expect(await relayer.relay(secondRequest)).toMatchObject({ code: "ALREADY_SUBMITTED" });

    pending.resolve({ day: 7, n: 1, goal: 5, in_closers: false });
    expect((await first).ok).toBe(true);
    expect(await relayer.relay(thirdRequest)).toMatchObject({ code: "ALREADY_SUBMITTED" });
    expect(gateway.submissions).toHaveLength(1);
  });

  test("allows the same account again on the next day", async () => {
    const { gateway, relayer } = setup();
    expect((await relayer.relay(await signedRequest(ALICE, 7))).ok).toBe(true);
    gateway.today = 8;
    expect((await relayer.relay(await signedRequest(ALICE, 8))).ok).toBe(true);
  });

  test("allows a retry after the submission failed", async () => {
    const { gateway, relayer } = setup();
    gateway.respond = async () => {
      throw new Error("RPC unavailable");
    };
    await expect(relayer.relay(await signedRequest(ALICE, 7))).rejects.toThrow("RPC unavailable");

    gateway.respond = async (submission) => ({ day: submission.day, n: 1, goal: 5, in_closers: true });
    expect(await relayer.relay(await signedRequest(ALICE, 7))).toMatchObject({ ok: true });
  });
});

describe("CheckInRelayer order and contract errors", () => {
  test("submits one at a time in arrival order, even when an earlier request is checked last", async () => {
    const { gateway, relayer } = setup();
    const answers = new Map([ALICE, BOB, CAROL].map((account) => [account, deferred<CheckInResult>()]));
    const started: string[] = [];
    gateway.respond = (submission) => {
      started.push(submission.accountId);
      return answers.get(submission.accountId)?.promise ?? Promise.reject(new Error("unknown account"));
    };
    // Alice arrives first but her key lookup is the slowest, so her checks finish last.
    const lookUp = gateway.getCheckinKey.bind(gateway);
    gateway.getCheckinKey = async (accountId) => {
      if (accountId === ALICE) await Bun.sleep(50);
      return lookUp(accountId);
    };

    const requests = await Promise.all([ALICE, BOB, CAROL].map((account) => signedRequest(account, 7)));
    const results = requests.map((request) => relayer.relay(request));

    await until(() => started.length === 1);
    await Bun.sleep(20);
    expect(started).toEqual([ALICE]);

    answers.get(ALICE)?.reject(contractError("ERR_WARMUP"));
    await until(() => started.length === 2);
    await Bun.sleep(20);
    expect(started).toEqual([ALICE, BOB]);

    answers.get(BOB)?.resolve({ day: 7, n: 1, goal: 5, in_closers: false });
    await until(() => started.length === 3);
    expect(started).toEqual([ALICE, BOB, CAROL]);
    answers.get(CAROL)?.resolve({ day: 7, n: 2, goal: 5, in_closers: false });

    const outcomes = await Promise.all(results);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, true, true]);
  });

  test("a refused request does not let later requests pass an earlier pending one", async () => {
    const { gateway, relayer } = setup();
    const first = deferred<CheckInResult>();
    const started: string[] = [];
    gateway.respond = async (submission) => {
      started.push(submission.accountId);
      return submission.accountId === ALICE ? first.promise : { day: 7, n: 2, goal: 5, in_closers: false };
    };

    const aliceRequest = await signedRequest(ALICE, 7);
    const badRequest = { ...(await signedRequest(BOB, 7)), account_id: CAROL };
    const bobRequest = await signedRequest(BOB, 7);

    const alice = relayer.relay(aliceRequest);
    const bad = relayer.relay(badRequest);
    const bob = relayer.relay(bobRequest);

    expect(await bad).toMatchObject({ code: "ERR_BAD_SIGNATURE" });
    await Bun.sleep(20);
    expect(started).toEqual([ALICE]);

    first.resolve({ day: 7, n: 1, goal: 5, in_closers: false });
    expect((await alice).ok).toBe(true);
    expect((await bob).ok).toBe(true);
    expect(started).toEqual([ALICE, BOB]);
  });

  test("an unexpected failure during the checks releases the line", async () => {
    const { gateway, relayer } = setup();
    // Fails by account, not by call count: the two checks run concurrently in either order.
    const lookUp = gateway.getCheckinKey.bind(gateway);
    gateway.getCheckinKey = async (accountId) => {
      if (accountId === ALICE) throw new Error("RPC unavailable");
      return lookUp(accountId);
    };

    // Both requests are signed first: a rejection must not happen before the test awaits it.
    const [aliceRequest, bobRequest] = await Promise.all([signedRequest(ALICE, 7), signedRequest(BOB, 7)]);
    const failing = relayer.relay(aliceRequest);
    const next = relayer.relay(bobRequest);
    await expect(failing).rejects.toThrow("RPC unavailable");
    expect((await next).ok).toBe(true);
  });

  test("ERR_BACKLOG is retried once with settle first", async () => {
    const { gateway, relayer } = setup();
    gateway.respond = async (submission) => {
      if (!submission.settleFirst) throw contractError("ERR_BACKLOG");
      return { day: submission.day, n: 3, goal: 5, in_closers: false };
    };

    expect(await relayer.relay(await signedRequest(ALICE, 7))).toMatchObject({ ok: true, result: { n: 3 } });
    expect(gateway.submissions.map((submission) => submission.settleFirst)).toEqual([false, true]);
  });

  test("a second ERR_BACKLOG is returned, not retried again", async () => {
    const { gateway, relayer } = setup();
    gateway.respond = async () => {
      throw contractError("ERR_BACKLOG");
    };

    expect(await relayer.relay(await signedRequest(ALICE, 7))).toMatchObject({
      ok: false,
      code: "CONTRACT_ERROR",
      contractCode: "ERR_BACKLOG",
    });
    expect(gateway.submissions).toHaveLength(2);
  });

  test("warm-up and an earlier check-in are refused before the relayer pays gas", async () => {
    const { gateway, relayer } = setup();
    gateway.member(ALICE, undefined, { isActive: false });
    expect(await relayer.relay(await signedRequest(ALICE, 7))).toMatchObject({ ok: false, code: "ERR_WARMUP" });
    gateway.member(ALICE, undefined, { checkedInToday: true });
    expect(await relayer.relay(await signedRequest(ALICE, 7))).toMatchObject({
      ok: false,
      code: "ERR_ALREADY_CHECKED_IN",
    });
    expect(gateway.submissions).toEqual([]);
  });

  test("a final contract refusal keeps the reservation: a replay costs no second transaction", async () => {
    const { gateway, relayer } = setup();
    gateway.respond = async () => {
      throw new ContractCallError("ERR_ALREADY_CHECKED_IN");
    };
    const request = await signedRequest(ALICE, 7);
    expect(await relayer.relay(request)).toMatchObject({ code: "CONTRACT_ERROR" });
    expect(await relayer.relay(request)).toMatchObject({ ok: false, code: "ALREADY_SUBMITTED" });
    expect(gateway.submissions).toHaveLength(1);
  });

  test("a transient refusal releases the reservation so the member can retry", async () => {
    const { gateway, relayer } = setup();
    gateway.respond = async () => {
      throw new ContractCallError("ERR_LOW_GAS");
    };
    const request = await signedRequest(ALICE, 7);
    expect(await relayer.relay(request)).toMatchObject({ contractCode: "ERR_LOW_GAS" });
    gateway.respond = async (submission) => ({ day: submission.day, n: 1, goal: 5, in_closers: true });
    expect(await relayer.relay(request)).toMatchObject({ ok: true });
  });

  test("other contract errors are returned with their code and not retried", async () => {
    const { gateway, relayer } = setup();
    gateway.respond = async () => {
      throw new ContractCallError("ERR_ALREADY_CHECKED_IN");
    };

    expect(await relayer.relay(await signedRequest(ALICE, 7))).toMatchObject({
      ok: false,
      code: "CONTRACT_ERROR",
      contractCode: "ERR_ALREADY_CHECKED_IN",
    });
    expect(gateway.submissions).toHaveLength(1);
  });
});

describe("CheckInRelayer without Ed25519 support", () => {
  afterEach(() => {
    spyOn(crypto.subtle, "importKey").mockRestore();
  });

  test("fails as a server error instead of refusing the signature", async () => {
    const { gateway, relayer } = setup();
    const request = await signedRequest(ALICE, 7);
    expect(base64ToBytes(request.signature)).toHaveLength(64);

    spyOn(crypto.subtle, "importKey").mockRejectedValue(new DOMException("Unrecognized name.", "NotSupportedError"));
    await expect(relayer.relay(request)).rejects.toThrow("cannot verify ed25519");
    expect(gateway.submissions).toEqual([]);
  });
});
