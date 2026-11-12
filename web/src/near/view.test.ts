import { afterAll, describe, expect, test } from "bun:test";

import { callView, contractPanic, createViewProvider, ViewTimeoutError } from "./view";

// Panic texts are in the form nearcore sends them: a Rust debug string inside
// `GuestPanic { panic_msg: "..." }`. `String.raw` keeps the backslashes exactly as on the wire.

describe("contractPanic", () => {
  test("decodes the near-sdk panic hook form and finds the ERR_ code after the newline", () => {
    const error = new Error(
      String.raw`wasm execution failed with error: HostError(GuestPanic { panic_msg: "panicked at src/lib.rs:10:5:\nERR_NOT_MEMBER" })`
    );
    expect(contractPanic(error)).toEqual({
      message: "panicked at src/lib.rs:10:5:\nERR_NOT_MEMBER",
      code: "ERR_NOT_MEMBER",
    });
  });

  test("decodes escaped quotes, as observed from testnet on 2026-11-12", () => {
    const error = new Error(
      String.raw`wasm execution failed with error: HostError(GuestPanic { panic_msg: "panicked at 'Failed to deserialize input from JSON.: Error(\"missing field ` +
        "`account_id`" +
        String.raw`\", line: 1, column: 2)', src/lib.rs:43:1" })`
    );
    expect(contractPanic(error)).toEqual({
      message:
        "panicked at 'Failed to deserialize input from JSON.: Error(\"missing field `account_id`\", line: 1, column: 2)', src/lib.rs:43:1",
      code: undefined,
    });
  });

  test("finds a bare ERR_ code and one followed by details", () => {
    expect(contractPanic(new Error('HostError(GuestPanic { panic_msg: "ERR_NOT_MEMBER" })'))).toEqual({
      message: "ERR_NOT_MEMBER",
      code: "ERR_NOT_MEMBER",
    });
    expect(contractPanic(new Error('HostError(GuestPanic { panic_msg: "ERR_BACKLOG: 61 days pending" })'))?.code).toBe(
      "ERR_BACKLOG"
    );
  });

  test("ends at the closing quote, not at the last brace in the text", () => {
    const withBraceInside = new Error(String.raw`GuestPanic { panic_msg: "bad \" } value" })`);
    expect(contractPanic(withBraceInside)?.message).toBe('bad " } value');

    const withTextAfter = new Error('GuestPanic { panic_msg: "ERR_WARMUP" }) while calling "check_in" }');
    expect(contractPanic(withTextAfter)).toEqual({ message: "ERR_WARMUP", code: "ERR_WARMUP" });
  });

  test("decodes the other Rust debug escapes", () => {
    const error = new Error(String.raw`GuestPanic { panic_msg: "a\tb\rc\\d\'e\u{1f600}f\0g" }`);
    expect(contractPanic(error)?.message).toBe("a\tb\rc\\d'e\u{1f600}f\0g");
  });

  test("returns undefined for errors that are not contract panics", () => {
    expect(contractPanic(new Error("wasm execution failed with error: HostError(GasExceeded)"))).toBeUndefined();
    expect(contractPanic(new Error('GuestPanic { panic_msg: "unterminated'))).toBeUndefined();
    expect(contractPanic(new Error("fetch failed"))).toBeUndefined();
    expect(contractPanic("ERR_NOT_MEMBER")).toBeUndefined();
    expect(contractPanic(undefined)).toBeUndefined();
  });
});

// The servers below listen on localhost only: these tests need no network.
describe("callView against a local server", () => {
  let unavailableRequests = 0;
  const unavailable = Bun.serve({
    port: 0,
    fetch() {
      unavailableRequests += 1;
      return new Response("unavailable", { status: 503 });
    },
  });
  const silent = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: () => new Promise<Response>(() => {}),
  });

  afterAll(async () => {
    await unavailable.stop(true);
    await silent.stop(true);
  });

  test("gives up on a failing RPC after two attempts", async () => {
    const provider = createViewProvider(`http://localhost:${unavailable.port}`);
    const started = performance.now();

    await expect(callView(provider, { contractId: "lastcall.testnet", method: "get_state" })).rejects.toBeInstanceOf(
      Error
    );

    // near-api-js's default is 12 attempts over more than a minute.
    expect(unavailableRequests).toBe(2);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("rejects with ViewTimeoutError when the RPC accepts the request and never answers", async () => {
    const provider = createViewProvider(`http://localhost:${silent.port}`);
    const started = performance.now();

    await expect(
      callView(provider, { contractId: "lastcall.testnet", method: "get_state", timeoutMs: 300 })
    ).rejects.toBeInstanceOf(ViewTimeoutError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
