import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsPromises = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", () => fsPromises);

const fsSync = vi.hoisted(() => ({ createReadStream: vi.fn() }));
vi.mock("node:fs", () => fsSync);

const { buildApp } = await import("../src/app.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /fonts/:filename", () => {
  it("serves an existing font with the right content type, CORS and cache headers", async () => {
    fsPromises.stat.mockResolvedValue({});
    fsSync.createReadStream.mockReturnValue(Readable.from([Buffer.from("fake-font-bytes")]));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/brothers-regular.otf" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("font/otf");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.body).toBe("fake-font-bytes");
  });

  it("returns 404 for a filename outside our own font allowlist, without touching the disk", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/malicious.exe" });

    expect(res.statusCode).toBe(404);
    expect(fsPromises.stat).not.toHaveBeenCalled();
  });

  it("returns 404 when the font file doesn't exist on disk", async () => {
    fsPromises.stat.mockRejectedValue(new Error("ENOENT"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/fonts/missing.ttf" });

    expect(res.statusCode).toBe(404);
  });
});
