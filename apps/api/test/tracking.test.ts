import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getCampaignSendByTrackingToken: vi.fn(),
  recordEvent: vi.fn(),
}));
vi.mock("@carnival/db", () => db);

const { buildApp } = await import("../src/app.js");

const send = { id: 1, campaignId: 10, contactId: 100 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /t/o/:token", () => {
  it("records an open event and serves the pixel for a valid token", async () => {
    db.getCampaignSendByTrackingToken.mockResolvedValue(send);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/t/o/tok123" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(db.recordEvent).toHaveBeenCalledWith({ contactId: 100, campaignId: 10, sendId: 1, type: "open" });
  });

  it("still serves the pixel for an unknown token, without recording an event", async () => {
    db.getCampaignSendByTrackingToken.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/t/o/unknown" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(db.recordEvent).not.toHaveBeenCalled();
  });
});

describe("GET /t/c/:token", () => {
  it("records a click event and redirects to the original URL for a valid token", async () => {
    db.getCampaignSendByTrackingToken.mockResolvedValue(send);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/t/c/tok123?u=" + encodeURIComponent("https://example.com/oferta"),
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://example.com/oferta");
    expect(db.recordEvent).toHaveBeenCalledWith({
      contactId: 100,
      campaignId: 10,
      sendId: 1,
      type: "click",
      url: "https://example.com/oferta",
    });
  });

  it("rejects an unknown token instead of redirecting (would otherwise be an open redirect)", async () => {
    db.getCampaignSendByTrackingToken.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/t/c/unknown?u=" + encodeURIComponent("https://example.com/oferta"),
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
    expect(db.recordEvent).not.toHaveBeenCalled();
  });

  it("rejects a missing u param without querying the database", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/t/c/tok123" });

    expect(res.statusCode).toBe(400);
    expect(db.getCampaignSendByTrackingToken).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) u param (e.g. javascript:)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/t/c/tok123?u=javascript:alert(1)" });

    expect(res.statusCode).toBe(400);
    expect(db.getCampaignSendByTrackingToken).not.toHaveBeenCalled();
  });

  it("rejects a real, valid token if `u` points somewhere outside the allowed hosts (open redirect)", async () => {
    // A token proves "you're a real recipient", not "this destination is
    // safe" — it never expires, so anyone who ever got one real email could
    // otherwise turn this into an open redirector to any http(s) URL.
    db.getCampaignSendByTrackingToken.mockResolvedValue(send);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/t/c/tok123?u=" + encodeURIComponent("https://evil.example/phishing"),
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(db.getCampaignSendByTrackingToken).not.toHaveBeenCalled();
    expect(db.recordEvent).not.toHaveBeenCalled();
  });

  it("allows a subdomain of an allowed host", async () => {
    db.getCampaignSendByTrackingToken.mockResolvedValue(send);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/t/c/tok123?u=" + encodeURIComponent("https://www.example.com/oferta"),
    });

    expect(res.statusCode).toBe(302);
  });
});
