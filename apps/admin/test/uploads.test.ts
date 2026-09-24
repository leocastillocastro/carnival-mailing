import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

const fsPromises = vi.hoisted(() => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs/promises", () => fsPromises);

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "fixed-uuid",
}));

const { buildApp } = await import("../src/app.js");

const AUTH_COOKIE = { cookie: "carnival_admin_session=validtoken" };

beforeEach(() => {
  vi.clearAllMocks();
  db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
  fsPromises.mkdir.mockResolvedValue(undefined);
  fsPromises.writeFile.mockResolvedValue(undefined);
});

function multipartBody(boundary: string, filename: string, mimetype: string, content: Buffer) {
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([pre, content, post]);
}

describe("POST /uploads", () => {
  it("saves an allowed image and returns its public URL", async () => {
    const boundary = "----test123";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { ...AUTH_COOKIE, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "photo.png", "image/png", Buffer.from("fake-image-bytes")),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: "https://mailing.example.test/uploads/fixed-uuid.png" });
    expect(fsPromises.writeFile).toHaveBeenCalledWith(expect.stringContaining("fixed-uuid.png"), expect.any(Buffer));
  });

  it("rejects a disallowed file type", async () => {
    const boundary = "----test123";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { ...AUTH_COOKIE, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "doc.pdf", "application/pdf", Buffer.from("%PDF-1.4")),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("no permitido");
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a request with no file part", async () => {
    const boundary = "----test123";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/uploads",
      headers: { ...AUTH_COOKIE, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}--\r\n`),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("No se recibió ningún archivo");
  });
});

describe("GET /uploads/gallery", () => {
  it("maps WordPress media items into a simplified shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["x-wp-totalpages", "3"]]),
      json: async () => [
        {
          id: 12,
          title: { rendered: "Chuletón" },
          source_url: "https://example.test/wp-content/uploads/full.jpg",
          media_details: {
            sizes: {
              thumbnail: { source_url: "https://example.test/wp-content/uploads/thumb.jpg" },
              large: { source_url: "https://example.test/wp-content/uploads/large.jpg" },
            },
          },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/gallery?page=1", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      items: [
        {
          id: 12,
          title: "Chuletón",
          thumbnailUrl: "https://example.test/wp-content/uploads/thumb.jpg",
          url: "https://example.test/wp-content/uploads/large.jpg",
        },
      ],
      hasMore: true,
    });
  });

  it("falls back to source_url when a media item has no size variants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map(),
        json: async () => [{ id: 5, title: { rendered: "Foto" }, source_url: "https://example.test/original.jpg" }],
      }),
    );

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/gallery", headers: AUTH_COOKIE });

    expect(JSON.parse(res.body).items[0]).toEqual({
      id: 5,
      title: "Foto",
      thumbnailUrl: "https://example.test/original.jpg",
      url: "https://example.test/original.jpg",
    });
  });

  it("treats a 400 from WordPress (page past the last one) as an empty final page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/gallery?page=99", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [], hasMore: false });
  });

  it("returns 502 for any other upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/uploads/gallery", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(502);
  });
});
