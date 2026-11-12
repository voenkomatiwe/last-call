import { describe, expect, spyOn, test } from "bun:test";

import { createCheckInHandler } from "./check-in-handler";
import { CheckInRelayer } from "./check-in-relayer";
import { contractError, FakeGateway, signedRequest } from "./test-support";

const ALICE = "alice.testnet";

function post(body: string): Request {
  return new Request("http://localhost/api/checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function handlerWith(gateway: FakeGateway) {
  const relayer = new CheckInRelayer(gateway);
  return createCheckInHandler(() => relayer);
}

describe("POST /api/checkin", () => {
  test("answers 503 while no relayer is configured", async () => {
    const response = await createCheckInHandler(() => undefined)(post("{}"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "RELAYER_NOT_CONFIGURED" });
  });

  test("returns the contract's result for a valid check-in", async () => {
    const handle = handlerWith(new FakeGateway().member(ALICE));
    const response = await handle(post(JSON.stringify(await signedRequest(ALICE, 7))));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, result: { day: 7, n: 1, goal: 5, in_closers: false } });
  });

  test("maps refusals to status codes", async () => {
    const gateway = new FakeGateway().member(ALICE);
    const handle = handlerWith(gateway);

    const invalidJson = await handle(post("{not json"));
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const tooLarge = await handle(post(JSON.stringify({ padding: "x".repeat(5000) })));
    expect(tooLarge.status).toBe(400);

    const wrongDay = await handle(post(JSON.stringify(await signedRequest(ALICE, 6))));
    expect(wrongDay.status).toBe(409);
    expect(await wrongDay.json()).toMatchObject({ code: "ERR_BAD_DAY", today: 7 });

    const stranger = await handle(post(JSON.stringify(await signedRequest("stranger.testnet", 7))));
    expect(stranger.status).toBe(403);

    gateway.respond = async () => {
      throw contractError("ERR_WARMUP");
    };
    const refused = await handle(post(JSON.stringify(await signedRequest(ALICE, 7))));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "CONTRACT_ERROR", contractCode: "ERR_WARMUP" });
  });

  test("hides internal errors behind a generic 500", async () => {
    const gateway = new FakeGateway().member(ALICE);
    gateway.respond = async () => {
      throw new Error("relayer key secret-xyz rejected by https://internal.rpc");
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});

    const response = await handlerWith(gateway)(post(JSON.stringify(await signedRequest(ALICE, 7))));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: "RELAYER_FAILED" });
    expect(text).not.toContain("secret-xyz");
    expect(text).not.toContain("internal.rpc");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
