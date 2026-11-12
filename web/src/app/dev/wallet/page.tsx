import type { Metadata } from "next";

import { loadNearConfig, type NearConfig } from "@/near/near-config";
import { WalletDiagnostics } from "@/wallet/wallet-diagnostics";

export const metadata: Metadata = { title: "Wallet diagnostics" };

// Used when the contract is not configured yet: the recipient only has to be the same string on
// both sides of the signature test.
const FALLBACK_RECIPIENT = "lastcall.testnet";

function configuredOrFallback(): Pick<NearConfig, "network" | "contractId"> {
  try {
    return loadNearConfig({
      NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
      NEXT_PUBLIC_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
      NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
    });
  } catch {
    return { network: "testnet", contractId: FALLBACK_RECIPIENT };
  }
}

export default function WalletDiagnosticsPage() {
  const { network, contractId } = configuredOrFallback();

  return (
    <main>
      <h1>Wallet diagnostics</h1>
      <p>
        Checks whether a wallet signs a check-in message the way the contract verifies it (NEP-413 without a callback
        URL).
      </p>
      <WalletDiagnostics network={network} recipient={contractId} />
    </main>
  );
}
