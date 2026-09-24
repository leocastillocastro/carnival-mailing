import { describe, expect, it } from "vitest";
import { parseIdParam } from "../src/params.js";

describe("parseIdParam", () => {
  it("parses a plain positive integer string", () => {
    expect(parseIdParam("42")).toBe(42);
  });

  it("returns null for a non-numeric id", () => {
    expect(parseIdParam("abc")).toBeNull();
  });

  it("returns null for a decimal, negative, or empty value", () => {
    expect(parseIdParam("1.5")).toBeNull();
    expect(parseIdParam("-1")).toBeNull();
    expect(parseIdParam("")).toBeNull();
  });

  it("returns null for a value with trailing garbage (e.g. path traversal attempt)", () => {
    expect(parseIdParam("1;drop table")).toBeNull();
    expect(parseIdParam("../../etc/passwd")).toBeNull();
  });
});
