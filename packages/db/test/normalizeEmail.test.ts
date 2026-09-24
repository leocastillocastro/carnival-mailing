import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/normalizeEmail.js";

describe("normalizeEmail", () => {
  it("lowercases", () => {
    expect(normalizeEmail("Jane@Example.com")).toBe("jane@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  jane@example.com  ")).toBe("jane@example.com");
  });

  it("is idempotent", () => {
    const once = normalizeEmail("Jane@Example.com");
    expect(normalizeEmail(once)).toBe(once);
  });
});
