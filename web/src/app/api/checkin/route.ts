import { createCheckInHandler } from "@/relayer/check-in-handler";
import type { CheckInRelayer } from "@/relayer/check-in-relayer";

// Never prerender or cache: every request is a separate check-in.
export const dynamic = "force-dynamic";

/**
 * No NEAR gateway exists yet: its view and transaction shapes need a built contract (plan
 * section 4). Until then the route answers 503 and players check in directly with `check_in()`.
 */
function relayer(): CheckInRelayer | undefined {
  return undefined;
}

export const POST = createCheckInHandler(relayer);
