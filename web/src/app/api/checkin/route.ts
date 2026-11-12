import { createCheckInHandler } from "@/relayer/check-in-handler";
import type { CheckInRelayer } from "@/relayer/check-in-relayer";
import { relayerFromEnv } from "@/relayer/relayer-config";

// Never prerender or cache: every request is a separate check-in.
export const dynamic = "force-dynamic";

/**
 * One relayer per server process, so its arrival-order queue and duplicate guard are shared by
 * every request. Without `RELAYER_ACCOUNT_ID` and `RELAYER_PRIVATE_KEY` the route answers 503 and
 * players check in directly with `check_in()`.
 */
let cached: CheckInRelayer | null | undefined;

function relayer(): CheckInRelayer | undefined {
  if (cached === undefined) {
    // A bad configuration is reported once and turns the relayer off (503), instead of a bare 500 on
    // every request. The message never contains the key (see relayer-config.ts).
    cached = safeRelayerFromEnv({
      NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
      NEXT_PUBLIC_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
      NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
      RELAYER_ACCOUNT_ID: process.env.RELAYER_ACCOUNT_ID,
      RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
    });
  }
  return cached ?? undefined;
}

function safeRelayerFromEnv(env: Parameters<typeof relayerFromEnv>[0]): CheckInRelayer | null {
  try {
    return relayerFromEnv(env);
  } catch (error) {
    console.error(`Relayer disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export const POST = createCheckInHandler(relayer);
