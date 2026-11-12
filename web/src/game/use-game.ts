"use client";

import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";

import { ContractReader } from "../contract/reader";
import type { DaySummary, OpenDayView } from "../contract/views";
import { contractView, createViewProvider } from "../near/view";
import type { AccountSnapshot, GameSnapshot } from "./actions";
import { parseShared, parseSharedResponse, readShared, type SharedRaw, type ViewFn } from "./shared-snapshot";

// Plan section 6.2 (LC-022, LC-023): the views every visitor shares come from `GET /api/game`, one
// server read for all pages, or straight from RPC when the server fails. The connected account's
// views are read here. A hidden tab polls nothing (`refetchIntervalInBackground` stays false).
/** Shared views: the live day, history, kickable members. */
export const LIVE_POLL_MS = 3_000;
/** The connected account's storage, balance, and member record. */
export const ACCOUNT_POLL_MS = 10_000;
/** How long the page waits for `/api/game` before reading RPC itself. */
const SERVER_TIMEOUT_MS = 4_000;

/** One client per page. The provider already retries twice, so queries do not retry again. */
export function createGameQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } } });
}

export interface GameData {
  readonly game: GameSnapshot;
  readonly openDay: OpenDayView;
  readonly history: readonly DaySummary[];
  readonly account: AccountSnapshot | null;
  /** `Date.now()` on this page's clock when `game.state` was read; `msToDayEnd` counts from here. */
  readonly readAt: number;
}

export interface GameView {
  readonly data: GameData | undefined;
  readonly kickable: readonly string[];
  /** The last read error; earlier data stays on screen. */
  readonly error: string | undefined;
  /** Re-reads the game and account views now, for example after the member's own transaction. */
  readonly refresh: () => void;
}

/** Reads `/api/game`; `readAt` is converted to this page's clock with the server's `ageMs`. */
async function readFromServer(contractId: string, signal: AbortSignal): Promise<{ views: SharedRaw; readAt: number }> {
  const response = await fetch("/api/game", {
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(SERVER_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new Error(`/api/game answered ${response.status}`);
  const { ageMs, views } = parseSharedResponse(await response.json(), contractId);
  // A CDN copy is older than the server said by its `Age` header (seconds).
  const cdnAge = Number(response.headers.get("age"));
  const cdnAgeMs = Number.isFinite(cdnAge) && cdnAge > 0 ? cdnAge * 1000 : 0;
  return { views, readAt: Date.now() - ageMs - cdnAgeMs };
}

/** Reads the contract for the page through TanStack Query (needs a `QueryClientProvider`). */
export function useGame(rpcUrl: string, contractId: string, accountId: string | null): GameView {
  const queryClient = useQueryClient();
  const provider = useMemo(() => createViewProvider(rpcUrl), [rpcUrl]);
  const reader = useMemo(() => new ContractReader(provider, contractId), [provider, contractId]);
  const directView = useMemo<ViewFn>(() => contractView(provider, contractId), [provider, contractId]);
  const base = useMemo(() => ["last-call", rpcUrl, contractId] as const, [rpcUrl, contractId]);
  /** The last raw views, so a direct read reuses config, history, and kickable members. */
  const lastRaw = useRef<SharedRaw | undefined>(undefined);
  /** Set by `refresh()`: the server cache may predate the member's own transaction, so read RPC once. */
  const directNext = useRef(false);

  const shared = useQuery({
    queryKey: [...base, "shared"],
    queryFn: async ({ signal }) => {
      let read: { views: SharedRaw; readAt: number };
      try {
        if (directNext.current) throw new Error("fresh read requested");
        read = await readFromServer(contractId, signal);
      } catch (cause) {
        if (signal.aborted) throw cause;
        directNext.current = false;
        // The backend is a cache, never a dependency: read the chain directly.
        const views = await readShared(directView, lastRaw.current);
        read = { views, readAt: views.readAt };
      }
      lastRaw.current = read.views;
      return { snapshot: parseShared(read.views), readAt: read.readAt };
    },
    refetchInterval: LIVE_POLL_MS,
  });

  const account = useQuery({
    queryKey: [...base, "account", accountId],
    queryFn: async (): Promise<AccountSnapshot> => {
      const id = accountId as string;
      const [storage, balance, member] = await Promise.all([
        reader.storageBalance(id),
        reader.balance(id),
        reader.member(id),
      ]);
      return { accountId: id, storage, balance, member };
    },
    enabled: accountId !== null,
    refetchInterval: ACCOUNT_POLL_MS,
  });

  const refresh = useCallback(() => {
    directNext.current = true;
    for (const part of ["shared", "account"]) {
      void queryClient.invalidateQueries({ queryKey: [...base, part] });
    }
  }, [queryClient, base]);

  const snapshot = shared.data?.snapshot;
  const accountReady = accountId === null || account.data !== undefined;
  const data: GameData | undefined =
    snapshot && shared.data && accountReady
      ? {
          game: { config: snapshot.config, state: snapshot.state, bounds: snapshot.bounds },
          openDay: snapshot.openDay,
          history: snapshot.history,
          account: accountId === null ? null : (account.data ?? null),
          readAt: shared.data.readAt,
        }
      : undefined;

  const failure = [shared, account].find((query) => query.error)?.error;
  const error = failure ? (failure instanceof Error ? failure.message : String(failure)) : undefined;

  return { data, kickable: snapshot?.kickable ?? [], error, refresh };
}
