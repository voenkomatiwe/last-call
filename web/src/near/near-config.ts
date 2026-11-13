import { isValidAccountId } from "./account-id";

export type NearNetwork = "testnet" | "mainnet";

export interface NearConfig {
  readonly network: NearNetwork;
  readonly contractId: string;
  /** One RPC endpoint, or several separated by commas, tried in order (`createViewProvider`). */
  readonly rpcUrl: string;
}

// FastNEAR first (plan section 6.2), then the other public testnet endpoints listed in the official
// provider table (docs.near.org/api/rpc/providers, read 14 Nov 2026): dRPC, Intear, ZAN. A rate limit
// on one moves reads to the next. `rpc.testnet.near.org` is deprecated and severely rate limited.
export const DEFAULT_RPC_URLS: Record<NearNetwork, string> = {
  testnet: [
    "https://test.rpc.fastnear.com",
    "https://near-testnet.drpc.org",
    "https://testnet-rpc.intea.rs",
    "https://api.zan.top/near-testnet",
  ].join(","),
  mainnet: "https://free.rpc.fastnear.com",
};

export interface NearConfigEnv {
  readonly NEXT_PUBLIC_NEAR_NETWORK?: string | undefined;
  readonly NEXT_PUBLIC_CONTRACT_ID?: string | undefined;
  readonly NEXT_PUBLIC_NEAR_RPC_URL?: string | undefined;
}

/** A comma-separated list of endpoints; each must pass `parseRpcUrl`. */
function parseRpcUrls(value: string): string {
  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
  if (urls.length === 0) throw new Error("NEXT_PUBLIC_NEAR_RPC_URL is empty");
  return urls.map(parseRpcUrl).join(",");
}

function parseRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`NEXT_PUBLIC_NEAR_RPC_URL is not a URL: ${value}`);
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("NEXT_PUBLIC_NEAR_RPC_URL must use https, or http for localhost");
  }
  // The value is public and inlined into browser code: it must not carry credentials.
  if (url.username || url.password) {
    throw new Error("NEXT_PUBLIC_NEAR_RPC_URL must not contain credentials");
  }
  return url.toString();
}

/** Validates the public NEAR settings. Throws with the name of the offending variable. */
export function loadNearConfig(env: NearConfigEnv): NearConfig {
  const network = env.NEXT_PUBLIC_NEAR_NETWORK || "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`NEXT_PUBLIC_NEAR_NETWORK must be testnet or mainnet, got: ${network}`);
  }

  const contractId = env.NEXT_PUBLIC_CONTRACT_ID;
  if (!contractId) throw new Error("NEXT_PUBLIC_CONTRACT_ID is not set");
  if (!isValidAccountId(contractId)) {
    throw new Error(`NEXT_PUBLIC_CONTRACT_ID is not a valid NEAR account ID: ${contractId}`);
  }

  if (network === "mainnet" && contractId.endsWith(".testnet")) {
    throw new Error(
      `NEXT_PUBLIC_CONTRACT_ID is a testnet account but NEXT_PUBLIC_NEAR_NETWORK is mainnet: ${contractId}`
    );
  }

  const rpcUrl = env.NEXT_PUBLIC_NEAR_RPC_URL ? parseRpcUrls(env.NEXT_PUBLIC_NEAR_RPC_URL) : DEFAULT_RPC_URLS[network];
  return { network, contractId, rpcUrl };
}

/**
 * Reads the settings from the environment. Each variable is named literally because Next.js
 * inlines `NEXT_PUBLIC_` values into browser code only for literal `process.env.NAME` references.
 */
export function nearConfigFromEnv(): NearConfig {
  return loadNearConfig({
    NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
    NEXT_PUBLIC_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
    NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
  });
}
