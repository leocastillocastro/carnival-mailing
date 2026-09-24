import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSessionUser: vi.fn().mockResolvedValue(null),
  findUserByEmail: vi.fn(),
}));
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

// Proves the timing-side-channel fix behaviorally: verifyPassword must run
// even when no user was found, instead of the route short-circuiting before
// ever touching it (which is what let an attacker measure the difference).
const verifyPasswordSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  verifyPasswordSpy.mockImplementation(actual.verifyPassword);
  return { ...actual, verifyPassword: verifyPasswordSpy };
});

const { buildApp } = await import("../src/app.js");

beforeEach(() => {
  db.findUserByEmail.mockReset();
  verifyPasswordSpy.mockClear();
});

describe("login timing side-channel fix", () => {
  it("still runs the password derivation when the email doesn't exist", async () => {
    db.findUserByEmail.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "nobody@test.example", password: "whatever" },
    });

    expect(res.statusCode).toBe(200);
    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
  });

  it("still runs the password derivation for a real account with the wrong password", async () => {
    db.findUserByEmail.mockResolvedValue({ id: 1, email: "owner@test.example", passwordHash: "aa:bb" });
    const app = await buildApp();

    await app.inject({ method: "POST", url: "/login", payload: { email: "owner@test.example", password: "wrong" } });

    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
  });
});
