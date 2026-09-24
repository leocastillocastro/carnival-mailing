import { describe, expect, it } from "vitest";

const { buildApp } = await import("../src/app.js");

describe("security headers", () => {
  it("sets X-Content-Type-Options: nosniff on every response", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("404 handling", () => {
  it("serves a styled Spanish HTML page instead of Fastify's default JSON body", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/this-route-does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Página no encontrada");
    expect(res.body).not.toContain('"statusCode"');
  });
});
