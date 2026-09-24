import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth.js";

const db = vi.hoisted(() => ({
  findUserByEmail: vi.fn(),
  createSession: vi.fn(),
  getSessionUser: vi.fn(),
  destroySession: vi.fn(),
  getSubscribedContactCount: vi.fn(),
  getSentCampaignCount: vi.fn(),
  getMostRecentSentCampaign: vi.fn(),
}));
// @carnival/segments (pulled in transitively by the segments route) needs the
// real `schema`/`db` exports at import time — importOriginal keeps everything
// except the specific repo functions this test suite overrides.
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

const { buildApp } = await import("../src/app.js");

beforeEach(() => {
  vi.clearAllMocks();
  db.getSessionUser.mockResolvedValue(null);
  db.getSubscribedContactCount.mockResolvedValue(0);
  db.getSentCampaignCount.mockResolvedValue(0);
  db.getMostRecentSentCampaign.mockResolvedValue(null);
});

describe("GET /login", () => {
  it("renders the login form when not authenticated", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("form");
    expect(res.body).toContain("Iniciar sesión");
  });

  it("redirects to / when already authenticated", async () => {
    db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/login",
      headers: { cookie: "carnival_admin_session=validtoken" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
  });
});

describe("POST /login", () => {
  it("sets a session cookie and redirects on correct credentials", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");
    db.findUserByEmail.mockResolvedValue({ id: 1, email: "owner@carnival.test", passwordHash });
    db.createSession.mockResolvedValue({ token: "newtoken", expiresAt: new Date(Date.now() + 1000) });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "owner@carnival.test", password: "correct horse battery staple" },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(res.headers["set-cookie"]).toContain("carnival_admin_session=newtoken");
  });

  it("shows an error and sets no cookie on wrong password", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");
    db.findUserByEmail.mockResolvedValue({ id: 1, email: "owner@carnival.test", passwordHash });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "owner@carnival.test", password: "wrong" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Email o contraseña incorrectos");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(db.createSession).not.toHaveBeenCalled();
  });

  it("shows the same error for an unknown email (no user enumeration)", async () => {
    db.findUserByEmail.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "nobody@carnival.test", password: "whatever" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Email o contraseña incorrectos");
  });

  it("locks out further attempts from the same IP after 5 tries within the window", async () => {
    db.findUserByEmail.mockResolvedValue(null);
    const app = await buildApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/login", payload: { email: "x@test.example", password: "x" } });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "POST", url: "/login", payload: { email: "x@test.example", password: "x" } });
    expect(blocked.statusCode).toBe(429);
  });
});

describe("session guard", () => {
  // "/" is behind the same auth preHandler as every other admin page —
  // picked here so the guard itself is what's under test, not any
  // particular page's render.
  it("redirects protected routes to /login without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("allows protected routes through with a valid session cookie", async () => {
    db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: "carnival_admin_session=validtoken" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /logout", () => {
  it("destroys the session and clears the cookie", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: "carnival_admin_session=validtoken" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(db.destroySession).toHaveBeenCalledWith("validtoken");
  });
});
