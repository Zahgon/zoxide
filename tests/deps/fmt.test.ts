/**
 * Rust's `{:.N}` float formatting, which prints the score column. `toFixed`
 * disagrees on exact ties, so the rounding mode is asserted explicitly.
 */
import { describe, expect, test } from "vitest";

import { formatFixed, formatFixedRightAligned } from "../../src/deps/fmt.ts";

describe("format!(\"{:.1}\")", () => {
  test.each([
    [0.25, "0.2"],
    [0.35, "0.3"],
    [0.75, "0.8"],
    [2.5, "2.5"],
    [0.05, "0.1"],
    [1.25, "1.2"],
    [1.35, "1.4"],
    [0, "0.0"],
    [9999, "9999.0"],
    [12.04, "12.0"],
  ])("%f => %s", (value, expected) => {
    expect(formatFixed(value, 1)).toBe(expected);
  });

  test("rounds half to even, unlike toFixed", () => {
    expect(formatFixed(0.25, 1)).toBe("0.2");
    expect((0.25).toFixed(1)).toBe("0.3");
  });

  test("right-aligns in six columns", () => {
    expect(formatFixedRightAligned(0, 6, 1)).toBe("   0.0");
    expect(formatFixedRightAligned(12.5, 6, 1)).toBe("  12.5");
    expect(formatFixedRightAligned(9999, 6, 1)).toBe("9999.0");
    expect(formatFixedRightAligned(12345.6, 6, 1)).toBe("12345.6");
  });
});
