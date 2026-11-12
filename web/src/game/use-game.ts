"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ContractReader } from "../contract/reader";
import type { DaySummary, OpenDayView } from "../contract/views";
import { createViewProvider } from "../near/view";
import type { AccountSnapshot, GameSnapshot } from "./actions";

/** Plan section 6.2: poll every 2 s. */
const POLL_MS = 2_000;
/** Kickable members change slowly and need several pages: poll less often. */
const KICKABLE_POLL_MS = 20_000;

export interface GameData {
  readonly game: GameSnapshot;
  readonly openDay: OpenDayView;
  readonly history: readonly DaySummary[];
  readonly account: AccountSnapshot | null;
  /** `Date.now()` when `game.state` was read; `msToDayEnd` counts from here. */
  readonly readAt: number;
}

export interface GameView {
  readonly data: GameData | undefined;
  readonly kickable: readonly string[];
  /** The last read error; earlier data stays on screen. */
  readonly error: string | undefined;
  readonly refresh: () => void;
}

/** Reads the contract for the page: game state every 2 s, the connected account's view with it. */
export function useGame(rpcUrl: string, contractId: string, accountId: string | null): GameView {
  const reader = useMemo(() => new ContractReader(createViewProvider(rpcUrl), contractId), [rpcUrl, contractId]);
  const [data, setData] = useState<GameData | undefined>(undefined);
  const [kickable, setKickable] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const configRef = useRef<GameSnapshot["config"] | undefined>(undefined);
  const boundsRef = useRef<GameSnapshot["bounds"] | undefined>(undefined);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` forces an immediate re-read.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read() {
      try {
        // Config and storage bounds are fixed at deploy: read them once.
        configRef.current ??= await reader.config();
        boundsRef.current ??= await reader.storageBalanceBounds();
        const [state, openDay, history, account] = await Promise.all([
          reader.state(),
          reader.openDay(),
          reader.history(),
          accountId
            ? Promise.all([reader.storageBalance(accountId), reader.balance(accountId), reader.member(accountId)]).then(
                ([storage, balance, member]): AccountSnapshot => ({ accountId, storage, balance, member })
              )
            : Promise.resolve(null),
        ]);
        if (!active) return;
        setData({
          game: { config: configRef.current, state, bounds: boundsRef.current },
          openDay,
          history,
          account,
          readAt: Date.now(),
        });
        setError(undefined);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (active) timer = setTimeout(read, POLL_MS);
    }

    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [reader, accountId, tick]);

  useEffect(() => {
    let active = true;
    async function read() {
      try {
        const accounts = await reader.allKickable();
        if (active) setKickable(accounts);
      } catch {
        // A hint only: keep the last list.
      }
    }
    read();
    const timer = setInterval(read, KICKABLE_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reader]);

  return { data, kickable, error, refresh };
}
