import { FailoverRpcError, FailoverRpcProvider, JsonRpcProvider, type Provider } from "near-api-js";

// Contract view calls go through near-api-js. Its typed errors cover the structural failures:
// `AccountDoesNotExistError`, `ContractCodeDoesNotExistError`, and `ContractMethodNotFoundError`
// from `near-api-js/rpc-errors`. A contract panic arrives as a generic error whose message holds
// nearcore's debug output; `contractPanic` below extracts the panic message and the `ERR_` code.

/**
 * `retries` is the number of attempts. near-api-js makes 12 by default, with a delay that grows
 * from 500 ms, which can hold a failing request for over a minute. The page polls every few
 * seconds, so a failed read must surface quickly: two attempts, 300 ms apart.
 */
const RETRY_OPTIONS = { retries: 2, wait: 300, backoff: 2 };

/** near-api-js sets no time limit on a request, so a server that never answers would hang a read. */
const DEFAULT_TIMEOUT_MS = 8_000;

export class ViewTimeoutError extends Error {
  override readonly name = "ViewTimeoutError";
}

/** `rpcUrl` may list several endpoints separated by commas (`near-config.ts`), tried in order. */
export function rpcUrlList(rpcUrl: string): string[] {
  return rpcUrl
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
}

/**
 * One endpoint gives a plain JSON-RPC provider; several give near-api-js's `FailoverRpcProvider`,
 * which moves to the next endpoint when a request fails (a rate limit, an outage), so one busy public
 * RPC does not stall the page.
 */
export function createViewProvider(rpcUrl: string): Provider {
  const providers = rpcUrlList(rpcUrl).map((url) => new JsonRpcProvider({ url }, RETRY_OPTIONS));
  const [first] = providers;
  if (!first) throw new Error("No RPC endpoint configured");
  return providers.length === 1 ? first : new FailoverRpcProvider(providers);
}

/**
 * `FailoverRpcProvider` wraps every endpoint's failure in one `FailoverRpcError`. A contract panic
 * fails the same on every endpoint, so return the failure that carries one, else the last.
 */
export function unwrapFailover(error: unknown): unknown {
  if (!(error instanceof FailoverRpcError)) return error;
  return error.errors.find((e) => contractPanic(e) !== undefined) ?? error.errors.at(-1) ?? error;
}

export interface ViewCall {
  readonly contractId: string;
  readonly method: string;
  readonly args?: Record<string, unknown>;
  /** Time limit for the whole call, retries included. */
  readonly timeoutMs?: number;
}

/**
 * Calls a view method and returns its JSON result, not yet validated: the caller must check the
 * shape before using it. Integers above 2^53 lose precision in JSON parsing, so the contract must
 * return such values as strings. Reads use near-api-js's default `optimistic` finality.
 */
export async function callView(provider: Provider, call: ViewCall): Promise<unknown> {
  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ViewTimeoutError(`${call.contractId}.${call.method} did not answer in ${timeoutMs} ms`)),
      timeoutMs
    );
  });

  try {
    // near-api-js cannot abort a request; after a timeout the abandoned one ends on its own.
    return await Promise.race([
      provider.callFunction({ contractId: call.contractId, method: call.method, args: call.args ?? {} }),
      timeout,
    ]);
  } catch (error) {
    throw unwrapFailover(error);
  } finally {
    clearTimeout(timer);
  }
}

export interface ContractPanic {
  /** The panic message of the contract. */
  readonly message: string;
  /** The contract's `ERR_...` code found in the message (plan section 4.7), if any. */
  readonly code: string | undefined;
}

const PANIC_PREFIX = 'GuestPanic { panic_msg: "';
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "0": "\0",
  "'": "'",
  '"': '"',
  "\\": "\\",
};

/**
 * Reads a Rust debug string literal that starts right after its opening quote. nearcore prints the
 * panic message that way, so `\n`, `\"`, `\u{...}` and the like are escapes, and the literal ends
 * at the first unescaped quote.
 */
function readRustDebugString(text: string, start: number): string | undefined {
  let value = "";
  for (let index = start; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '"') return value;
    if (character !== "\\") {
      value += character;
      continue;
    }

    const escaped = text.charAt(index + 1);
    const unicode = escaped === "u" ? text.slice(index + 2).match(/^\{([0-9a-fA-F]{1,6})\}/) : null;
    if (unicode?.[1]) {
      value += String.fromCodePoint(Number.parseInt(unicode[1], 16));
      index += 1 + unicode[0].length;
    } else {
      value += SIMPLE_ESCAPES[escaped] ?? `\\${escaped}`;
      index += 1;
    }
  }
  return undefined;
}

/** Recognizes a contract panic in an error thrown by a view call or a transaction. */
export function contractPanic(error: unknown): ContractPanic | undefined {
  if (!(error instanceof Error)) return undefined;
  const prefixAt = error.message.indexOf(PANIC_PREFIX);
  if (prefixAt === -1) return undefined;

  const message = readRustDebugString(error.message, prefixAt + PANIC_PREFIX.length);
  if (message === undefined) return undefined;
  return { message, code: message.match(/\bERR_[A-Z0-9_]+/)?.[0] };
}

/** `callView` bound to one contract: `(method, args) => raw JSON`, not yet validated. */
export function contractView(
  provider: Provider,
  contractId: string
): (method: string, args?: Record<string, unknown>) => Promise<unknown> {
  return (method, args = {}) => callView(provider, { contractId, method, args });
}
