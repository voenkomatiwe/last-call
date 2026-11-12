import { isValidAccountId } from "../near/account-id";

// Strict readers for JSON that comes from the contract. Every view result is untrusted input: a
// missing field, a wrong type, or a malformed amount throws `ContractShapeError` with the path.

export class ContractShapeError extends Error {
  override readonly name = "ContractShapeError";
}

const U32_MAX = 0xffff_ffff;
const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function fail(path: string, expected: string, value: unknown): never {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  throw new ContractShapeError(`${path}: expected ${expected}, got ${shown.slice(0, 80)}`);
}

export function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object", value);
  return value as Record<string, unknown>;
}

export function asU32(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
    fail(path, "a u32", value);
  }
  return value;
}

/** A u64 the contract sends as a JSON number (for example `ms_to_day_end`); must be a safe integer. */
export function asSafeU64Number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(path, "a safe u64 number", value);
  return value;
}

function asDecimal(value: unknown, path: string, max: bigint, label: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) fail(path, `a ${label} decimal string`, value);
  const parsed = BigInt(value);
  if (parsed > max) fail(path, `a ${label} decimal string`, value);
  return parsed;
}

/** `U128` in near-sdk JSON: a decimal string. */
export function asU128(value: unknown, path: string): bigint {
  return asDecimal(value, path, U128_MAX, "U128");
}

/** `U64` in near-sdk JSON: a decimal string. */
export function asU64String(value: unknown, path: string): bigint {
  return asDecimal(value, path, U64_MAX, "U64");
}

export function asBool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean", value);
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "a string", value);
  return value;
}

export function asAccountId(value: unknown, path: string): string {
  if (typeof value !== "string" || !isValidAccountId(value)) fail(path, "an account ID", value);
  return value;
}

export function asArray<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, "an array", value);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

export function nullable<T>(read: (value: unknown, path: string) => T): (value: unknown, path: string) => T | null {
  return (value, path) => (value === null ? null : read(value, path));
}
