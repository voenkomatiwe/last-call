import { expect, test } from "bun:test";

import { formatBps, formatCountdown, formatLast, formatNear, formatUnits } from "./format";

test("token amounts round down, group thousands, and keep tiny amounts visible", () => {
  expect(formatLast(100_000n * 10n ** 18n)).toBe("100,000.00 LAST");
  expect(formatUnits(12_345_678_900_000_000_000_000n, 18)).toBe("12,345.67");
  expect(formatUnits(0n, 18)).toBe("0.00");
  expect(formatUnits(1n, 18)).toBe("<0.01");
  expect(formatUnits(-1_500_000_000_000_000_000n, 18)).toBe("-1.50");
  expect(formatUnits(5n, 0, 0)).toBe("5");
});

test("yoctoNEAR", () => {
  expect(formatNear(10_000_000_000_000_000_000_000n)).toBe("0.01000 NEAR");
  expect(formatNear(1_250_000_000_000_000_000_000n)).toBe("0.00125 NEAR");
});

test("countdown", () => {
  expect(formatCountdown(3_725_000)).toBe("1:02:05");
  expect(formatCountdown(65_400)).toBe("1:05");
  expect(formatCountdown(-5)).toBe("0:00");
});

test("basis points", () => {
  expect(formatBps(2000)).toBe("20%");
  expect(formatBps(5)).toBe("0.05%");
});
