import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getContactByTrackingToken: vi.fn(),
  unsubscribeContact: vi.fn(),
  resubscribeContact: vi.fn(),
  addSuppression: vi.fn(),
  removeSuppression: vi.fn(),
  isEmailSuppressed: vi.fn(),
  recordEvent: vi.fn(),
}));
vi.mock("@carnival/db", () => db);

const { buildApp } = await import("../src/app.js");

const contactRef = { contactId: 100, email: "cliente@example.com", campaignId: 10, sendId: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  db.isEmailSuppressed.mockResolvedValue(false);
});

describe("POST /unsubscribe/:token (RFC 8058 one-click)", () => {
  it("unsubscribes immediately with no page rendered", async () => {
    db.getContactByTrackingToken.mockResolvedValue(contactRef);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/unsubscribe/tok123" });

    expect(res.statusCode).toBe(200);
    expect(db.unsubscribeContact).toHaveBeenCalledWith(100);
    expect(db.addSuppression).toHaveBeenCalledWith("cliente@example.com", "unsubscribe");
    expect(db.recordEvent).toHaveBeenCalledWith({ contactId: 100, campaignId: 10, sendId: 1, type: "unsubscribe" });
  });

  it("still returns 200 for an unknown token, without unsubscribing anything", async () => {
    db.getContactByTrackingToken.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/unsubscribe/unknown" });

    expect(res.statusCode).toBe(200);
    expect(db.unsubscribeContact).not.toHaveBeenCalled();
  });
});

describe("GET /unsubscribe/:token", () => {
  // Must NOT act on a bare GET — mail-security gateways (Proofpoint,
  // Microsoft Safe Links, etc.) pre-fetch every link in an email before a
  // human opens it, so a GET that unsubscribes fires for people who never
  // clicked anything. This only looks the token up and shows a confirm form.
  it("does not unsubscribe on GET — only shows a confirmation form", async () => {
    db.getContactByTrackingToken.mockResolvedValue(contactRef);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/unsubscribe/tok123" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(db.unsubscribeContact).not.toHaveBeenCalled();
    expect(res.body).toContain('action="/unsubscribe/tok123/confirm"');
    expect(res.body).toContain('method="post"');
  });

  it("serves a generic page for an unknown/expired token instead of a 404", async () => {
    db.getContactByTrackingToken.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/unsubscribe/unknown" });

    expect(res.statusCode).toBe(200);
    expect(db.unsubscribeContact).not.toHaveBeenCalled();
  });
});

describe("POST /unsubscribe/:token/confirm", () => {
  it("unsubscribes and serves a confirmation page with an undo link", async () => {
    db.getContactByTrackingToken.mockResolvedValue(contactRef);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/unsubscribe/tok123/confirm" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(db.unsubscribeContact).toHaveBeenCalledWith(100);
    expect(res.body).toContain("/unsubscribe/tok123/resubscribe");
  });

  it("serves a generic page for an unknown/expired token instead of a 404", async () => {
    db.getContactByTrackingToken.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/unsubscribe/unknown/confirm" });

    expect(res.statusCode).toBe(200);
    expect(db.unsubscribeContact).not.toHaveBeenCalled();
  });
});

describe("GET /unsubscribe/:token/resubscribe", () => {
  it("does not resubscribe on GET — only shows a confirmation form", async () => {
    db.getContactByTrackingToken.mockResolvedValue(contactRef);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/unsubscribe/tok123/resubscribe" });

    expect(res.statusCode).toBe(200);
    expect(db.resubscribeContact).not.toHaveBeenCalled();
    expect(res.body).toContain('action="/unsubscribe/tok123/resubscribe/confirm"');
    expect(res.body).toContain('method="post"');
  });
});

describe("POST /unsubscribe/:token/resubscribe/confirm", () => {
  it("resubscribes and removes the suppression", async () => {
    db.getContactByTrackingToken.mockResolvedValue(contactRef);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/unsubscribe/tok123/resubscribe/confirm" });

    expect(res.statusCode).toBe(200);
    expect(db.resubscribeContact).toHaveBeenCalledWith(100);
    expect(db.removeSuppression).toHaveBeenCalledWith("cliente@example.com", "unsubscribe");
  });

  it("does not reset contacts.status if the contact is still suppressed for another reason (bounce/complaint)", async () => {
    // suppressions.email is uniquely constrained (one row per email, not per
    // reason) — if the real suppression was for "bounce", the earlier
    // unsubscribeByToken's addSuppression("unsubscribe") was a no-op, so
    // removeSuppression("unsubscribe") here removes nothing and the contact
    // is still suppressed. Resetting status to "subscribed" in that case
    // would show them as subscribed while a real send still can't reach
    // them.
    db.getContactByTrackingToken.mockResolvedValue(contactRef);
    db.isEmailSuppressed.mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/unsubscribe/tok123/resubscribe/confirm" });

    expect(res.statusCode).toBe(200);
    expect(db.removeSuppression).toHaveBeenCalledWith("cliente@example.com", "unsubscribe");
    expect(db.resubscribeContact).not.toHaveBeenCalled();
  });
});
