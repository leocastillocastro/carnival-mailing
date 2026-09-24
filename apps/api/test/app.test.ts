import { describe, expect, it } from "vitest";
import { buildApp, redactSesToken } from "../src/app.js";

describe("redactSesToken", () => {
  it("redacts the token segment of a SES webhook URL", () => {
    expect(redactSesToken("/webhooks/ses/abc123secrettoken")).toBe("/webhooks/ses/[redacted]");
  });

  it("preserves a query string after the token", () => {
    expect(redactSesToken("/webhooks/ses/abc123?foo=bar")).toBe("/webhooks/ses/[redacted]?foo=bar");
  });

  it("leaves unrelated URLs untouched", () => {
    expect(redactSesToken("/webhooks/woocommerce")).toBe("/webhooks/woocommerce");
    expect(redactSesToken("/health")).toBe("/health");
    expect(redactSesToken("/t/o/sometrackingtoken")).toBe("/t/o/sometrackingtoken");
  });
});

describe("security headers", () => {
  it("sets X-Content-Type-Options: nosniff on every response", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("trustProxy", () => {
  it("uses X-Forwarded-For for request.ip instead of the immediate socket peer (Caddy's own address)", async () => {
    const app = await buildApp();
    app.get("/__test-ip", async (request) => ({ ip: request.ip }));

    const res = await app.inject({
      method: "GET",
      url: "/__test-ip",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });

    expect(JSON.parse(res.body).ip).toBe("203.0.113.5");
  });
});

describe("malformed request bodies", () => {
  // Observed in production from a bot probing an unrelated PHP-CGI exploit
  // (the payload is a PHP snippet, not JSON) — a bad body is the client's
  // fault, not a server bug, and should read that way in the response and
  // in the logs (a plain thrown Error defaults to 500, which looks like a
  // crash for what's actually a correctly-rejected request).
  it("returns 400, not 500, for a body that isn't valid JSON", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/hello.world",
      headers: { "content-type": "application/json" },
      payload: '<?php shell_exec("id"); ?>',
    });

    expect(res.statusCode).toBe(400);
  });

  it("never echoes a stack trace or file path back to the client", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/hello.world",
      headers: { "content-type": "application/json" },
      payload: '<?php shell_exec("id"); ?>',
    });

    expect(res.body).not.toContain("/home/");
    expect(res.body).not.toContain(" at ");
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
