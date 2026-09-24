import { describe, expect, it } from "vitest";
import { comunidadAutonomaFromPostcode } from "../src/spanishRegions.js";

describe("comunidadAutonomaFromPostcode", () => {
  it("maps a Barcelona postcode to Cataluña", () => {
    expect(comunidadAutonomaFromPostcode("08004")).toBe("Cataluña");
  });

  it("maps a Madrid postcode to Comunidad de Madrid", () => {
    expect(comunidadAutonomaFromPostcode("28013")).toBe("Comunidad de Madrid");
  });

  it("maps the lowest and highest province codes", () => {
    expect(comunidadAutonomaFromPostcode("01001")).toBe("País Vasco");
    expect(comunidadAutonomaFromPostcode("52001")).toBe("Melilla");
  });

  it("returns null for a missing postcode", () => {
    expect(comunidadAutonomaFromPostcode(undefined)).toBeNull();
    expect(comunidadAutonomaFromPostcode(null)).toBeNull();
    expect(comunidadAutonomaFromPostcode("")).toBeNull();
  });

  it("returns null for an out-of-range province prefix", () => {
    expect(comunidadAutonomaFromPostcode("99999")).toBeNull();
  });

  it("returns null for a non-numeric or too-short prefix instead of guessing", () => {
    expect(comunidadAutonomaFromPostcode("AB123")).toBeNull();
    expect(comunidadAutonomaFromPostcode("8")).toBeNull();
  });

  it("trims surrounding whitespace before reading the prefix", () => {
    expect(comunidadAutonomaFromPostcode("  08004  ")).toBe("Cataluña");
  });
});
