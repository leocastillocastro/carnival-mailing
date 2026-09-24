import { describe, expect, it } from "vitest";
import { isFinalAttempt } from "../src/retryPolicy.js";

describe("isFinalAttempt", () => {
  it("is false while attempts remain", () => {
    expect(isFinalAttempt(1, 5)).toBe(false);
    expect(isFinalAttempt(4, 5)).toBe(false);
  });

  it("is true once attemptsMade reaches the configured max", () => {
    expect(isFinalAttempt(5, 5)).toBe(true);
  });

  it("is true if attemptsMade somehow exceeds the max", () => {
    expect(isFinalAttempt(6, 5)).toBe(true);
  });

  it("is true immediately for a job configured with a single attempt", () => {
    expect(isFinalAttempt(1, 1)).toBe(true);
  });
});
