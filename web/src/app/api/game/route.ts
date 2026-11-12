import { createSharedHandler, type SharedSource } from "@/game/shared-handler";
import { nearConfigFromEnv } from "@/near/near-config";
import { contractView, createViewProvider } from "@/near/view";

// Every request answers from the server's own 2 s cache (see shared-handler.ts), never a build-time copy.
export const dynamic = "force-dynamic";

/** One source per server process, so every request shares its cache. */
let source: SharedSource | null | undefined;

function sharedSource(): SharedSource | undefined {
  if (source === undefined) {
    try {
      const config = nearConfigFromEnv();
      const provider = createViewProvider(config.rpcUrl);
      source = {
        contractId: config.contractId,
        view: contractView(provider, config.contractId),
      };
    } catch (error) {
      console.error(`/api/game disabled: ${error instanceof Error ? error.message : String(error)}`);
      source = null;
    }
  }
  return source ?? undefined;
}

export const GET = createSharedHandler(sharedSource);
