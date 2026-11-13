import { GameScreen } from "@/game/game-screen";
import { nearConfigFromEnv } from "@/near/near-config";

export default function HomePage() {
  let config: ReturnType<typeof nearConfigFromEnv>;
  try {
    config = nearConfigFromEnv();
  } catch (error) {
    return (
      <main className="lc-config">
        <h1>Last Call ($LAST)</h1>
        <p role="alert">
          The page is not configured: {error instanceof Error ? error.message : String(error)}. Copy web/.env.example to
          web/.env.local and set NEXT_PUBLIC_CONTRACT_ID.
        </p>
      </main>
    );
  }

  return (
    <main>
      {/* The neon sign in the scene names the game; the heading and the summary are for screen readers. */}
      <h1 className="lc-sr-only">Last Call ($LAST)</h1>
      <p className="lc-sr-only">
        A memecoin with a daily check-in. Every day a share of active members must check in. A successful day pays
        everyone who did and draws a hero for the jackpot; a failed day burns part of the pot and slashes absent
        members.
      </p>
      <GameScreen network={config.network} contractId={config.contractId} rpcUrl={config.rpcUrl} />
    </main>
  );
}
