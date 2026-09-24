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

describe("GET /uploads/:filename", () => {
  it("serves an existing file with the right content type and cache headers", async () => {
    fsPromises.stat.mockResolvedValue({});
    fsSync.createReadStream.mockReturnValue(Readable.from([Buffer.from("fake-bytes")]));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/abc-123.png" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.body).toBe("fake-bytes");
  });

  it("returns 404 for a filename that doesn't match our own upload naming pattern, without touching the disk", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/malicious.exe" });

    expect(res.statusCode).toBe(404);
    expect(fsPromises.stat).not.toHaveBeenCalled();
  });

  it("returns 404 when the file doesn't exist on disk", async () => {
    fsPromises.stat.mockRejectedValue(new Error("ENOENT"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/missing-uuid.jpg" });

    expect(res.statusCode).toBe(404);
  });
});
