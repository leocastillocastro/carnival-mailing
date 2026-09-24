import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getAllSegments: vi.fn(),
  getSegmentById: vi.fn(),
  getAllLists: vi.fn(),
  getDistinctAttributeValues: vi.fn(),
  createSegment: vi.fn(),
  updateSegment: vi.fn(),
  deleteSegment: vi.fn(),
}));
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

const segmentsPkg = vi.hoisted(() => ({ countContactsMatchingRule: vi.fn(), resolveSegmentContactsPage: vi.fn() }));
vi.mock("@carnival/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/segments")>()),
  ...segmentsPkg,
}));

const { buildApp } = await import("../src/app.js");

const AUTH_COOKIE = { cookie: "carnival_admin_session=validtoken" };

beforeEach(() => {
  vi.clearAllMocks();
  db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
  db.getAllLists.mockResolvedValue([{ id: 5, name: "Newsletter", description: null, optin: "single" }]);
  db.getDistinctAttributeValues.mockResolvedValue(["Barcelona", "Madrid"]);
});

describe("POST /segments", () => {
  it("creates a segment from a valid rule tree", async () => {
    db.createSegment.mockResolvedValue({ id: 1 });
    const definition = { glue: "and", conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }] };

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments",
      headers: AUTH_COOKIE,
      payload: { name: "Suscriptos", definition: JSON.stringify(definition) },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/segments/1/edit?flash=");
    expect(db.createSegment).toHaveBeenCalledWith({ name: "Suscriptos", definition });
  });

  it("rejects malformed JSON without calling createSegment", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments",
      headers: AUTH_COOKIE,
      payload: { name: "Roto", definition: "{not json" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("no es un JSON válido");
    expect(db.createSegment).not.toHaveBeenCalled();
  });

  it("rejects a rule tree with an unknown condition kind", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments",
      headers: AUTH_COOKIE,
      payload: {
        name: "Inválido",
        definition: JSON.stringify({ glue: "and", conditions: [{ kind: "raw_sql", query: "DROP TABLE contacts" }] }),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Definición de segmento inválida");
    expect(db.createSegment).not.toHaveBeenCalled();
  });

  it("rejects a pathologically deep rule tree instead of crashing the process", async () => {
    let group: unknown = { kind: "contact_field", field: "status", op: "eq", value: "subscribed" };
    for (let i = 0; i < 50; i++) group = { glue: "and", conditions: [group] };

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments",
      headers: AUTH_COOKIE,
      payload: { name: "Demasiado anidado", definition: JSON.stringify(group) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("nested too deeply");
    expect(db.createSegment).not.toHaveBeenCalled();
  });

  it("shows a friendly Spanish message for an empty conditions array", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments",
      headers: AUTH_COOKIE,
      payload: { name: "Vacío", definition: JSON.stringify({ glue: "and", conditions: [] }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Agregá al menos una condición");
    expect(db.createSegment).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments",
      headers: AUTH_COOKIE,
      payload: { name: "", definition: JSON.stringify({ glue: "and", conditions: [] }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("El nombre es obligatorio");
    expect(db.createSegment).not.toHaveBeenCalled();
  });
});

describe("GET /segments/:id/edit", () => {
  it("round-trips the stored definition into the page's embedded JSON", async () => {
    const definition = { glue: "or", conditions: [{ kind: "contact_attribute", path: "tier", op: "eq", value: "vip" }] };
    db.getSegmentById.mockResolvedValue({ id: 7, name: "VIPs", definition, updatedAt: new Date() });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/segments/7/edit", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(JSON.stringify(definition));
  });

  it("neutralizes a literal </script> inside a condition value so it can't break out of the embedded JSON", async () => {
    const definition = {
      glue: "and",
      conditions: [{ kind: "contact_attribute", path: "note", op: "eq", value: "</script><script>alert(1)</script>" }],
    };
    db.getSegmentById.mockResolvedValue({ id: 8, name: "Ataque", definition, updatedAt: new Date() });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/segments/8/edit", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("</script><script>alert(1)</script>");
    expect(res.body).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
  });

  it("returns 404 for a missing segment", async () => {
    db.getSegmentById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/segments/999/edit", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /segments/preview-count", () => {
  it("counts matches for a valid, unsaved rule tree", async () => {
    segmentsPkg.countContactsMatchingRule.mockResolvedValue(42);
    const definition = { glue: "and", conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }] };

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments/preview-count",
      headers: AUTH_COOKIE,
      payload: { definition: JSON.stringify(definition) },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 42 });
    expect(segmentsPkg.countContactsMatchingRule).toHaveBeenCalledWith(definition);
  });

  it("returns 400 with an error message for malformed JSON, without counting", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments/preview-count",
      headers: AUTH_COOKIE,
      payload: { definition: "{not json" },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(segmentsPkg.countContactsMatchingRule).not.toHaveBeenCalled();
  });

  it("returns 400 for a rule tree that fails schema validation", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/segments/preview-count",
      headers: AUTH_COOKIE,
      payload: { definition: JSON.stringify({ glue: "and", conditions: [{ kind: "raw_sql" }] }) },
    });

    expect(res.statusCode).toBe(400);
    expect(segmentsPkg.countContactsMatchingRule).not.toHaveBeenCalled();
  });
});

describe("POST /segments/:id/delete", () => {
  it("deletes and redirects", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/segments/7/delete", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(302);
    expect(db.deleteSegment).toHaveBeenCalledWith(7);
  });
});

describe("GET /segments/:id/contacts", () => {
  it("shows a page of matching contacts with their status", async () => {
    db.getSegmentById.mockResolvedValue({ id: 7, name: "VIPs" });
    segmentsPkg.resolveSegmentContactsPage.mockResolvedValue({
      contacts: [{ id: 1, email: "ana@example.com", firstName: "Ana", lastName: null, status: "subscribed" }],
      total: 1,
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/segments/7/contacts", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ana@example.com");
    expect(res.body).toContain("Suscrito");
    expect(segmentsPkg.resolveSegmentContactsPage).toHaveBeenCalledWith(7, { limit: 50, offset: 0 });
  });

  it("offsets by page number", async () => {
    db.getSegmentById.mockResolvedValue({ id: 7, name: "VIPs" });
    segmentsPkg.resolveSegmentContactsPage.mockResolvedValue({ contacts: [], total: 0 });
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/segments/7/contacts?page=3", headers: AUTH_COOKIE });
    expect(segmentsPkg.resolveSegmentContactsPage).toHaveBeenCalledWith(7, { limit: 50, offset: 100 });
  });

  it("404s for a nonexistent segment", async () => {
    db.getSegmentById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/segments/999/contacts", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
  });
});
