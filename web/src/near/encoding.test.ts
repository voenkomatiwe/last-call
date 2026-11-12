import { expect, test } from "bun:test";

import { base58ToBytes, base64ToBytes, bytesToBase58, bytesToBase64, bytesToHex, hexToBytes } from "./encoding";

test("hex round-trips and rejects malformed input", () => {
  expect(bytesToHex(Uint8Array.of(0, 15, 255))).toBe("000fff");
  expect(hexToBytes("000FFF")).toEqual(Uint8Array.of(0, 15, 255));
  expect(() => hexToBytes("abc")).toThrow("Invalid hex");
  expect(() => hexToBytes("zz")).toThrow("Invalid hex");
});

test("base64 round-trips and rejects malformed input", () => {
  expect(bytesToBase64(Uint8Array.of(0, 255, 16))).toBe("AP8Q");
  expect(base64ToBytes("AP8Q")).toEqual(Uint8Array.of(0, 255, 16));
  expect(() => base64ToBytes("***")).toThrow("Invalid base64");
});

test("base58 matches known Bitcoin-alphabet values and keeps leading zero bytes", () => {
  // "Hello World!" is the widely published base58 example.
  expect(bytesToBase58(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
  expect(new TextDecoder().decode(base58ToBytes("2NEpo7TZRRrLZSi2U"))).toBe("Hello World!");

  expect(bytesToBase58(Uint8Array.of(0, 0, 1))).toBe("112");
  expect(base58ToBytes("112")).toEqual(Uint8Array.of(0, 0, 1));
  expect(bytesToBase58(new Uint8Array(0))).toBe("");
  expect(base58ToBytes("")).toEqual(new Uint8Array(0));
  expect(() => base58ToBytes("0OIl")).toThrow("Invalid base58");
});
