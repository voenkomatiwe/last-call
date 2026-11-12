import { readShared, type SharedRaw, type SharedResponse, type ViewFn } from "./shared-snapshot";

// `GET /api/game` (LC-023): the shared views for every page from one server-side read. The server is
// a cache, not an authority: pages fall back to direct RPC reads when it fails.

/** A server read younger than this is served as is. */
export const SHARED_SERVER_TTL_MS = 2_000;

/** Lets a CDN serve one answer to many pages for a second, and a slightly older one while it refreshes. */
export const SHARED_CACHE_CONTROL = "public, max-age=0, s-maxage=1, stale-while-revalidate=4";

export interface SharedSource {
  readonly contractId: string;
  readonly view: ViewFn;
}

/**
 * Builds the handler. `source` returns undefined when the server is not configured (503). Concurrent
 * requests share one in-flight read; a read younger than `SHARED_SERVER_TTL_MS` is reused.
 */
export function createSharedHandler(
  source: () => SharedSource | undefined,
  now: () => number = Date.now
): () => Promise<Response> {
  let cached: SharedRaw | undefined;
  let inflight: Promise<SharedRaw> | undefined;

  function current(view: ViewFn): Promise<SharedRaw> {
    if (cached && now() - cached.readAt < SHARED_SERVER_TTL_MS) return Promise.resolve(cached);
    inflight ??= readShared(view, cached, now)
      .then((raw) => {
        cached = raw;
        return raw;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return async () => {
    const configured = source();
    if (!configured) {
      return Response.json({ error: "The server has no contract configured" }, { status: 503 });
    }
    try {
      const views = await current(configured.view);
      const body: SharedResponse = {
        contractId: configured.contractId,
        ageMs: Math.max(0, now() - views.readAt),
        views,
      };
      return Response.json(body, { headers: { "Cache-Control": SHARED_CACHE_CONTROL } });
    } catch (error) {
      // RPC and shape errors carry no secrets; the page falls back to direct reads.
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Could not read the contract: ${message}` }, { status: 502 });
    }
  };
}
