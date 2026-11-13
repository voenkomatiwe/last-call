import { expect, test } from "bun:test";

import { loadNearConfig } from "./near-config";

test("defaults to testnet and its public endpoints, FastNEAR first", () => {
  expect(loadNearConfig({ NEXT_PUBLIC_CONTRACT_ID: "lastcall.testnet" })).toEqual({
    network: "testnet",
    contractId: "lastcall.testnet",
    rpcUrl:
      "https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs,https://api.zan.top/near-testnet",
  });
});

test("accepts several endpoints separated by commas and checks each", () => {
  const env = { NEXT_PUBLIC_CONTRACT_ID: "lastcall.testnet" };
  expect(loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "https://a.example, https://b.example/x" }).rpcUrl).toBe(
    "https://a.example/,https://b.example/x"
  );
  expect(() => loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "https://a.example,http://b.example" })).toThrow(
    "must use https"
  );
  expect(() => loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: " , " })).toThrow("empty");
});

test("uses the mainnet endpoint for mainnet", () => {
  const config = loadNearConfig({ NEXT_PUBLIC_NEAR_NETWORK: "mainnet", NEXT_PUBLIC_CONTRACT_ID: "lastcall.near" });
  expect(config.rpcUrl).toBe("https://free.rpc.fastnear.com");
});

test("accepts an https override and http only for localhost", () => {
  const env = { NEXT_PUBLIC_CONTRACT_ID: "lastcall.test.near" };
  expect(loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "https://rpc.example/path" }).rpcUrl).toBe(
    "https://rpc.example/path"
  );
  expect(loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "http://localhost:3030" }).rpcUrl).toBe(
    "http://localhost:3030/"
  );
  expect(loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "http://[::1]:3030" }).rpcUrl).toBe("http://[::1]:3030/");
  expect(() => loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "https://user:secret@rpc.example" })).toThrow(
    "NEXT_PUBLIC_NEAR_RPC_URL must not contain credentials"
  );
  expect(() => loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "http://rpc.example" })).toThrow(
    "NEXT_PUBLIC_NEAR_RPC_URL must use https"
  );
  expect(() => loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "ftp://localhost" })).toThrow(
    "NEXT_PUBLIC_NEAR_RPC_URL must use https"
  );
  expect(() => loadNearConfig({ ...env, NEXT_PUBLIC_NEAR_RPC_URL: "not a url" })).toThrow(
    "NEXT_PUBLIC_NEAR_RPC_URL is not a URL"
  );
});

test("names the variable that is missing or invalid", () => {
  expect(() => loadNearConfig({})).toThrow("NEXT_PUBLIC_CONTRACT_ID is not set");
  expect(() => loadNearConfig({ NEXT_PUBLIC_CONTRACT_ID: "" })).toThrow("NEXT_PUBLIC_CONTRACT_ID is not set");
  expect(() => loadNearConfig({ NEXT_PUBLIC_CONTRACT_ID: "Last Call" })).toThrow(
    "NEXT_PUBLIC_CONTRACT_ID is not a valid NEAR account ID"
  );
  expect(() =>
    loadNearConfig({ NEXT_PUBLIC_NEAR_NETWORK: "mainnet", NEXT_PUBLIC_CONTRACT_ID: "lastcall.testnet" })
  ).toThrow("is a testnet account but NEXT_PUBLIC_NEAR_NETWORK is mainnet");
  expect(() => loadNearConfig({ NEXT_PUBLIC_NEAR_NETWORK: "sandbox", NEXT_PUBLIC_CONTRACT_ID: "a.testnet" })).toThrow(
    "NEXT_PUBLIC_NEAR_NETWORK must be testnet or mainnet"
  );
});
