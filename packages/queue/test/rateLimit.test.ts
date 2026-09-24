import { describe, expect, it } from "vitest";
import { computeLimiterOptions } from "../src/rateLimit.js";

describe("computeLimiterOptions", () => {
  it("uses a 10s window so a whole-number rate maps directly", () => {
    expect(computeLimiterOptions(5)).toEqual({ max: 50, duration: 10_000 });
  });

  it("preserves a fractional SES quota instead of flooring it to the integer part", () => {
    // 14.7/s over 1s would floor to 14 (a silent ~5% throughput loss); over 10s it's 147.
    expect(computeLimiterOptions(14.7)).toEqual({ max: 147, duration: 10_000 });
  });

  it("never returns max: 0 for a sub-1/s rate", () => {
    const { max } = computeLimiterOptions(0.05);
    expect(max).toBeGreaterThanOrEqual(1);
  });

  it("throws on a zero rate", () => {
    expect(() => computeLimiterOptions(0)).toThrow();
  });

  it("throws on a negative rate", () => {
    expect(() => computeLimiterOptions(-1)).toThrow();
  });

  it("throws on a non-finite rate", () => {
    expect(() => computeLimiterOptions(NaN)).toThrow();
    expect(() => computeLimiterOptions(Infinity)).toThrow();
  });
});
