import { Account, type KeyPairString } from "near-api-js";

import { ContractReader } from "../contract/reader";
import { isValidAccountId } from "../near/account-id";
import { loadNearConfig } from "../near/near-config";
import { createViewProvider } from "../near/view";
import { CheckInRelayer } from "./check-in-relayer";
import { NearCheckInGateway } from "./near-gateway";

// Server-only configuration of the relayer. The private key lives only in the environment
// (AGENTS.md: secrets); it is never logged, returned, or put in an error message.

export interface RelayerEnv {
  readonly NEXT_PUBLIC_NEAR_NETWORK?: string | undefined;
  readonly NEXT_PUBLIC_CONTRACT_ID?: string | undefined;
  readonly NEXT_PUBLIC_NEAR_RPC_URL?: string | undefined;
  readonly RELAYER_ACCOUNT_ID?: string | undefined;
  readonly RELAYER_PRIVATE_KEY?: string | undefined;
}

/** `null` when the relayer is not configured (the route then answers 503). Throws on a bad value. */
export function relayerFromEnv(env: RelayerEnv): CheckInRelayer | null {
  const accountId = env.RELAYER_ACCOUNT_ID;
  const privateKey = env.RELAYER_PRIVATE_KEY;
  if (!accountId && !privateKey) return null;
  if (!accountId || !isValidAccountId(accountId)) throw new Error("RELAYER_ACCOUNT_ID is missing or invalid");
  if (!privateKey?.startsWith("ed25519:")) throw new Error("RELAYER_PRIVATE_KEY must be an ed25519 secret key");

  const near = loadNearConfig(env);
  const provider = createViewProvider(near.rpcUrl);
  const account = new Account(accountId, provider, privateKey as KeyPairString);
  return new CheckInRelayer(new NearCheckInGateway(new ContractReader(provider, near.contractId), account));
}
