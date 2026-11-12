import type { JsonRpcProvider } from "near-api-js";

export interface AccessKeySummary {
  readonly total: number;
  readonly fullAccess: number;
}

/**
 * Counts the access keys of an account, for the "No admin key" block: a locked contract has none.
 * The RPC answer is untrusted, so only `keys[].access_key.permission` is read.
 */
export function summarizeAccessKeys(value: unknown): AccessKeySummary {
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new Error("view_access_key_list: expected keys to be an array");
  let fullAccess = 0;
  for (const key of keys) {
    const permission = (key as { access_key?: { permission?: unknown } } | null)?.access_key?.permission;
    if (permission === undefined) throw new Error("view_access_key_list: a key has no permission");
    if (permission === "FullAccess") fullAccess += 1;
  }
  return { total: keys.length, fullAccess };
}

export async function accessKeySummary(provider: JsonRpcProvider, accountId: string): Promise<AccessKeySummary> {
  return summarizeAccessKeys(await provider.viewAccessKeyList({ accountId }));
}
