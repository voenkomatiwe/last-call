import { asAccountId, asArray, asObject, asSafeU64Number, ContractShapeError } from "../contract/decode";
import {
  type ConfigView,
  type DaySummary,
  type OpenDayView,
  parseConfig,
  parseHistory,
  parseKickablePage,
  parseOpenDay,
  parseState,
  parseStorageBalanceBounds,
  type StateView,
  type StorageBalanceBounds,
} from "../contract/views";

// The views every visitor shares (plan section 6.2, LC-023). The server reads them for all pages and
// the page reads them directly when the server is unavailable, both through `readShared`. Values stay
// the contract's raw JSON so the page validates the server's answer with the same parsers.

/** A view call returning the contract's JSON, not yet validated. */
export type ViewFn = (method: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Kickable members change slowly and need several pages. */
export const KICKABLE_REFRESH_MS = 30_000;
const KICKABLE_PAGE = 200;
const HISTORY_LIMIT = 64;

/** Raw view results, each already validated once, with the times they were read (ms since epoch). */
export interface SharedRaw {
  readonly config: unknown;
  readonly bounds: unknown;
  readonly state: unknown;
  readonly openDay: unknown;
  readonly history: unknown;
  readonly kickable: readonly string[];
  /** When `state` was read. */
  readonly readAt: number;
  /** When `kickable` was read; 0 when it has never been read. */
  readonly kickableAt: number;
}

export interface SharedSnapshot {
  readonly config: ConfigView;
  readonly bounds: StorageBalanceBounds;
  readonly state: StateView;
  readonly openDay: OpenDayView;
  readonly history: readonly DaySummary[];
  readonly kickable: readonly string[];
}

/** History changes only when a day settles or a pending hero is drawn. */
function historyKey(state: StateView): string {
  return `${state.lastSettled}|${state.pendingHeroDays.join(",")}`;
}

/**
 * Reads the shared views, reusing from `previous` what cannot have changed: config and storage
 * bounds always, history while its key holds, kickable members for 30 s. A failed kickable read keeps
 * the previous list (it is a hint); any other failure rejects.
 */
export async function readShared(view: ViewFn, previous?: SharedRaw, now: () => number = Date.now): Promise<SharedRaw> {
  const config = previous?.config ?? (await view("get_config"));
  const bounds = previous?.bounds ?? (await view("storage_balance_bounds"));
  parseConfig(config);
  parseStorageBalanceBounds(bounds);

  const [state, openDay] = await Promise.all([view("get_state"), view("get_open_day")]);
  const readAt = now();
  const parsedState = parseState(state);
  parseOpenDay(openDay);

  const sameHistory = previous && historyKey(parseState(previous.state)) === historyKey(parsedState);
  const history = sameHistory ? previous.history : await view("get_history", { limit: HISTORY_LIMIT });
  parseHistory(history);

  let kickable = previous?.kickable ?? [];
  let kickableAt = previous?.kickableAt ?? 0;
  if (now() - kickableAt >= KICKABLE_REFRESH_MS) {
    try {
      kickable = await readKickable(view);
      kickableAt = now();
    } catch {
      // A hint only: keep the last list and try again on the next read.
    }
  }

  return { config, bounds, state, openDay, history, kickable, readAt, kickableAt };
}

async function readKickable(view: ViewFn): Promise<string[]> {
  const accounts: string[] = [];
  let from: number | null = 0;
  while (from !== null) {
    const page = parseKickablePage(await view("get_kickable", { from_index: from, limit: KICKABLE_PAGE }));
    accounts.push(...page.accounts);
    // A page that does not move forward would loop forever: refuse it.
    if (page.nextIndex !== null && page.nextIndex <= from) {
      throw new ContractShapeError(`get_kickable.next_index ${page.nextIndex} does not advance past ${from}`);
    }
    from = page.nextIndex;
  }
  return accounts;
}

/** Validates raw shared views (from the server or a direct read) into typed values. */
export function parseShared(raw: SharedRaw): SharedSnapshot {
  return {
    config: parseConfig(raw.config),
    bounds: parseStorageBalanceBounds(raw.bounds),
    state: parseState(raw.state),
    openDay: parseOpenDay(raw.openDay),
    history: parseHistory(raw.history),
    kickable: raw.kickable,
  };
}

/** The `GET /api/game` body: raw views plus how old `state` was when the response was made. */
export interface SharedResponse {
  readonly contractId: string;
  /** Milliseconds between reading `state` and answering; the page counts down from its own clock. */
  readonly ageMs: number;
  readonly views: SharedRaw;
}

/** Validates an untrusted `GET /api/game` body for `contractId`. */
export function parseSharedResponse(value: unknown, contractId: string): { ageMs: number; views: SharedRaw } {
  const p = "/api/game";
  const o = asObject(value, p);
  if (o.contractId !== contractId) {
    throw new ContractShapeError(`${p}.contractId ${JSON.stringify(o.contractId)} is not ${contractId}`);
  }
  const ageMs = asSafeU64Number(o.ageMs, `${p}.ageMs`);
  const v = asObject(o.views, `${p}.views`);
  const views: SharedRaw = {
    config: v.config,
    bounds: v.bounds,
    state: v.state,
    openDay: v.openDay,
    history: v.history,
    kickable: asArray(v.kickable, `${p}.views.kickable`, asAccountId),
    readAt: asSafeU64Number(v.readAt, `${p}.views.readAt`),
    kickableAt: asSafeU64Number(v.kickableAt, `${p}.views.kickableAt`),
  };
  parseShared(views);
  return { ageMs, views };
}
