import type { CheckInRelayer, RelayErrorCode } from "./check-in-relayer";

// HTTP mapping for `POST /api/checkin`. Kept apart from the route file so it can be tested without
// Next.js and with a relayer built on a fake gateway.

type HandlerErrorCode = RelayErrorCode | "RELAYER_NOT_CONFIGURED";

const STATUS: Record<HandlerErrorCode, number> = {
  INVALID_REQUEST: 400,
  ERR_BAD_SIGNATURE: 401,
  ERR_NOT_MEMBER: 403,
  ERR_NO_CHECKIN_KEY: 403,
  ERR_BAD_DAY: 409,
  ALREADY_SUBMITTED: 409,
  CONTRACT_ERROR: 422,
  RELAYER_FAILED: 500,
  RELAYER_NOT_CONFIGURED: 503,
};

/** A check-in request is four short fields; anything much larger is not one. */
const MAX_BODY_BYTES = 4096;

const NO_STORE = { "cache-control": "no-store" };

function errorResponse(code: HandlerErrorCode, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, code, message, ...extra }, { status: STATUS[code], headers: NO_STORE });
}

export function createCheckInHandler(getRelayer: () => CheckInRelayer | undefined) {
  return async function handleCheckIn(request: Request): Promise<Response> {
    const relayer = getRelayer();
    if (!relayer) {
      return errorResponse(
        "RELAYER_NOT_CONFIGURED",
        "The relayer is not configured. Check in directly with check_in()."
      );
    }

    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return errorResponse("INVALID_REQUEST", "The request body is too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse("INVALID_REQUEST", "The request body is not JSON");
    }

    try {
      const outcome = await relayer.relay(body);
      if (outcome.ok) return Response.json({ ok: true, result: outcome.result }, { headers: NO_STORE });
      const { code, message, ...extra } = outcome;
      return errorResponse(code, message, extra);
    } catch (error) {
      // Internal details stay in the server log.
      console.error("Check-in relay failed", error);
      return errorResponse("RELAYER_FAILED", "The relayer failed. Try again or check in directly with check_in().");
    }
  };
}
