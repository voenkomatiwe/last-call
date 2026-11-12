// Display formatting for token amounts, yoctoNEAR, and countdowns. Pure; amounts stay bigint.

export const LAST_DECIMALS = 18;
export const NEAR_DECIMALS = 24;

/** `12345678900000000000000n` with 18 decimals and 2 fraction digits → "12,345.67" (rounded down). */
export function formatUnits(amount: bigint, decimals: number, fractionDigits = 2): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = ((abs % base) * 10n ** BigInt(fractionDigits)) / base;
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fractionText = fractionDigits > 0 ? `.${fraction.toString().padStart(fractionDigits, "0")}` : "";
  // A positive amount below the shown precision must not read as zero.
  if (abs > 0n && whole === 0n && fraction === 0n) return `${negative ? "-" : ""}<0.${"0".repeat(fractionDigits - 1)}1`;
  return `${negative ? "-" : ""}${wholeText}${fractionText}`;
}

export function formatLast(amount: bigint): string {
  return `${formatUnits(amount, LAST_DECIMALS)} LAST`;
}

export function formatNear(yocto: bigint): string {
  return `${formatUnits(yocto, NEAR_DECIMALS, 5)} NEAR`;
}

/** 3_725_000 → "1:02:05"; 65_000 → "1:05"; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Basis points as a percentage: 2000 → "20%", 5 → "0.05%". */
export function formatBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
