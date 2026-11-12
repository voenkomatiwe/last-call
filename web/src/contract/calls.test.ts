import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  checkInCall,
  checkInSignedCall,
  claimCall,
  faucetCall,
  GAS,
  joinCall,
  kickCall,
  leaveCall,
  ONE_YOCTO,
  retryPickHeroCall,
  setCheckinKeyCall,
  settleCall,
  storageDepositCall,
} from "./calls";
import { CONTRACT_ERROR_MESSAGES, contractErrorCode, describeContractError } from "./errors";

const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const NONCE = Buffer.alloc(32, 1).toString("base64");
const SIGNATURE = Buffer.alloc(64, 2).toString("base64");
const SIGNED = { accountId: "alice.near", day: 3, nonceBase64: NONCE, signatureBase64: SIGNATURE };

describe("deposits follow API.md", () => {
  test("1 yocto for claim, leave, set_checkin_key", () => {
    for (const call of [claimCall(), leaveCall(), setCheckinKeyCall(KEY), setCheckinKeyCall(null)]) {
      expect(call.deposit).toBe(ONE_YOCTO);
    }
  });

  test("no deposit for check_in, check_in_signed, kick, settle, retry_pick_hero, faucet", () => {
    const signed = checkInSignedCall(SIGNED);
    for (const call of [
      checkInCall(),
      signed,
      kickCall("bob.near"),
      settleCall(),
      retryPickHeroCall(4),
      faucetCall(),
    ]) {
      expect(call.deposit).toBe("0");
    }
  });

  test("join and storage_deposit attach the given amounts", () => {
    expect(joinCall(10_000_000_000_000_000_000_000n, KEY)).toEqual({
      methodName: "join",
      args: { checkin_key: KEY },
      gas: GAS.game,
      deposit: "10000000000000000000000",
    });
    expect(joinCall(1n).args).toEqual({ checkin_key: null });
    expect(storageDepositCall(1_250_000_000_000_000_000_000n)).toMatchObject({
      args: { account_id: null, registration_only: true },
      deposit: "1250000000000000000000",
    });
    expect(() => joinCall(0n)).toThrow();
    expect(() => storageDepositCall(0n)).toThrow();
  });
});

describe("gas follows API.md", () => {
  test.each([
    ["join", joinCall(1n), GAS.game],
    ["check_in", checkInCall(), GAS.game],
    ["claim", claimCall(), GAS.game],
    ["leave", leaveCall(), GAS.game],
    ["kick", kickCall("bob.near"), GAS.game],
    ["check_in_signed", checkInSignedCall(SIGNED), GAS.checkInSigned],
    ["settle", settleCall(), GAS.settle],
    ["retry_pick_hero", retryPickHeroCall(1), GAS.retryPickHero],
    ["faucet", faucetCall(), GAS.light],
    ["storage_deposit", storageDepositCall(1n), GAS.light],
    ["set_checkin_key", setCheckinKeyCall(null), GAS.light],
  ])("%s", (_name, call, gas) => {
    expect(call.gas).toBe(gas);
  });

  test("the limits are at or above the attach column of API.md", () => {
    const tgas = (value: string) => Number(BigInt(value) / 1_000_000_000_000n);
    expect(tgas(GAS.game)).toBeGreaterThanOrEqual(100);
    expect(tgas(GAS.checkInSigned)).toBeGreaterThanOrEqual(50);
    expect(tgas(GAS.settle)).toBeGreaterThanOrEqual(300);
    expect(tgas(GAS.retryPickHero)).toBeGreaterThanOrEqual(50);
  });
});

describe("arguments are validated", () => {
  test("check-in keys must be ed25519", () => {
    expect(() => joinCall(1n, "secp256k1:abc")).toThrow();
    expect(() => setCheckinKeyCall("ed25519:")).toThrow();
    expect(() => setCheckinKeyCall("ed25519:0OIl")).toThrow();
    expect(() => setCheckinKeyCall(`${KEY}1`)).toThrow();
  });

  test("a valid key with leading zero bytes encodes shorter and is accepted", () => {
    // Bytes 00 01 11 ... (32 bytes) encode to 42 base58 characters (found in the LC-012 review).
    const shortKey = "ed25519:1wiUurocjAqg5NzA4gz1U1JDp29sVnQppSbCQWxzxG";
    expect(joinCall(1n, shortKey).args).toEqual({ checkin_key: shortKey });
  });

  test("account IDs and settle limits", () => {
    expect(() => kickCall("Not Valid")).toThrow();
    expect(settleCall(10).args).toEqual({ max_days: 10 });
    expect(settleCall().args).toEqual({ max_days: null });
    expect(() => settleCall(0)).toThrow();
  });

  test("check_in_signed passes the account, day, nonce, signature", () => {
    expect(checkInSignedCall(SIGNED).args).toEqual({
      account_id: "alice.near",
      day: 3,
      nonce: NONCE,
      signature: SIGNATURE,
    });
    expect(() => checkInSignedCall({ ...SIGNED, day: -3 })).toThrow("Invalid day");
    expect(() => checkInSignedCall({ ...SIGNED, day: 1.5 })).toThrow("Invalid day");
    expect(() => checkInSignedCall({ ...SIGNED, nonceBase64: Buffer.alloc(31).toString("base64") })).toThrow(
      "nonce must be 32 bytes"
    );
    expect(() => checkInSignedCall({ ...SIGNED, signatureBase64: NONCE })).toThrow("signature must be 64 bytes");
    expect(() => retryPickHeroCall(-1)).toThrow("Invalid day");
  });
});

describe("contract errors", () => {
  test("every ERR_ constant in errors.rs has a message, and no extra ones", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../contract/src/errors.rs")).text();
    const codes = [...source.matchAll(/pub const (ERR_[A-Z0-9_]+): &str/g)].map((m) => m[1]);
    expect(Object.keys(CONTRACT_ERROR_MESSAGES).sort()).toEqual(codes.sort() as string[]);
  });

  test("codes are found inside wallet and RPC error text", () => {
    expect(contractErrorCode("Smart contract panicked: ERR_ALREADY_CHECKED_IN")).toBe("ERR_ALREADY_CHECKED_IN");
    expect(contractErrorCode("ERR_UNKNOWN then ERR_WARMUP")).toBe("ERR_WARMUP");
    expect(contractErrorCode("Requires attached deposit of exactly 1 yoctoNEAR")).toBeUndefined();
    expect(describeContractError(new Error("panicked: ERR_BACKLOG"))).toContain("Settle");
    expect(describeContractError(new Error("network down"))).toBe("network down");
  });
});
