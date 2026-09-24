import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

const fsPromises = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", () => fsPromises);

const fsSync = vi.hoisted(() => ({ createReadStream: vi.fn() }));
vi.mock("node:fs", () => fsSync);

const { Readable } = await import("node:stream");
const { buildApp } = await import("../src/app.js");

const AUTH_COOKIE = { cookie: "carnival_admin_session=validtoken" };

beforeEach(() => {
  vi.clearAllMocks();
  db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
});

describe("GET /fonts/:filename", () => {
  it("serves an existing font with the right content type and cache headers", async () => {
    fsPromises.stat.mockResolvedValue({});
    fsSync.createReadStream.mockReturnValue(Readable.from([Buffer.from("fake-font-bytes")]));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/brothers-regular.otf", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("font/otf");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.body).toBe("fake-font-bytes");
  });

  it("serves a font without a session — the login page's own @font-face needs it before one exists", async () => {
    fsPromises.stat.mockResolvedValue({});
    fsSync.createReadStream.mockReturnValue(Readable.from([Buffer.from("fake-font-bytes")]));
    db.getSessionUser.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/brothers-regular.otf" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("fake-font-bytes");
  });

  it("returns 404 for a filename outside our own font allowlist, without touching the disk", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/malicious.exe", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(404);
    expect(fsPromises.stat).not.toHaveBeenCalled();
  });

  it("returns 404 when the font file doesn't exist on disk", async () => {
    fsPromises.stat.mockRejectedValue(new Error("ENOENT"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/missing.ttf", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(404);
  });
});
