import type { Metadata } from "next";

import { FaucetPanel } from "@/faucet/faucet-panel";
import { nearConfigFromEnv } from "@/near/near-config";

export const metadata: Metadata = { title: "$LAST faucet" };

export default function FaucetPage() {
  let config: ReturnType<typeof nearConfigFromEnv>;
  try {
    config = nearConfigFromEnv();
  } catch (error) {
    return (
      <main className="lc-config">
        <h1>$LAST faucet</h1>
        <p role="alert">
          The page is not configured: {error instanceof Error ? error.message : String(error)}. Set
          NEXT_PUBLIC_CONTRACT_ID in web/.env.local.
        </p>
      </main>
    );
  }

  return (
    <main className="lc-config">
      <h1>$LAST faucet</h1>
      <p>Testnet only. Each account can claim once; the contract enforces it.</p>
      <FaucetPanel network={config.network} contractId={config.contractId} rpcUrl={config.rpcUrl} />
    </main>
  );
}
