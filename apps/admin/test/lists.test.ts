import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getAllListsWithSubscriberCounts: vi.fn(),
  getListById: vi.fn(),
  getContactsForList: vi.fn(),
  createList: vi.fn(),
  updateList: vi.fn(),
  deleteList: vi.fn(),
}));
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

const { buildApp } = await import("../src/app.js");

const AUTH_COOKIE = { cookie: "carnival_admin_session=validtoken" };

beforeEach(() => {
  vi.clearAllMocks();
  db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
  db.getAllListsWithSubscriberCounts.mockResolvedValue([]);
});

describe("lists CRUD", () => {
  it("lists the index page", async () => {
    db.getAllListsWithSubscriberCounts.mockResolvedValue([
      { id: 1, name: "Newsletter", optin: "single", subscriberCount: 42 },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/lists", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Newsletter");
    expect(res.body).toContain("42");
  });

  it("creates a list and redirects with a flash message", async () => {
    db.createList.mockResolvedValue({ id: 2 });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/lists",
      headers: AUTH_COOKIE,
      payload: { name: "VIPs", description: "clientes frecuentes" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/lists/2/edit?flash=");
    expect(db.createList).toHaveBeenCalledWith({ name: "VIPs", description: "clientes frecuentes", optin: "single" });
  });

  // The form no longer offers a "double" choice (nothing ever implemented
  // what double opt-in should actually do), but the schema's optinEnum
  // still allows it — every list is single opt-in regardless of what a
  // direct POST claims.
  it("always creates a list as single opt-in, even if a direct POST claims otherwise", async () => {
    db.createList.mockResolvedValue({ id: 3 });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/lists",
      headers: AUTH_COOKIE,
      payload: { name: "VIPs", optin: "double" },
    });
    expect(db.createList).toHaveBeenCalledWith(expect.objectContaining({ optin: "single" }));
  });

  it("rejects an empty name", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/lists", headers: AUTH_COOKIE, payload: { name: "  " } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("El nombre es obligatorio");
    expect(db.createList).not.toHaveBeenCalled();
  });

  it("deletes a list", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/lists/3/delete", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(302);
    expect(db.deleteList).toHaveBeenCalledWith(3);
  });
});

describe("GET /lists/:id/contacts", () => {
  it("shows a page of members with their status", async () => {
    db.getListById.mockResolvedValue({ id: 5, name: "Newsletter" });
    db.getContactsForList.mockResolvedValue({
      contacts: [{ id: 1, email: "ana@example.com", firstName: "Ana", lastName: null, status: "unsubscribed" }],
      total: 1,
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/lists/5/contacts", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ana@example.com");
    expect(res.body).toContain("Dado de baja");
    expect(db.getContactsForList).toHaveBeenCalledWith(5, { limit: 50, offset: 0 });
  });

  it("offsets by page number", async () => {
    db.getListById.mockResolvedValue({ id: 5, name: "Newsletter" });
    db.getContactsForList.mockResolvedValue({ contacts: [], total: 0 });
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/lists/5/contacts?page=2", headers: AUTH_COOKIE });
    expect(db.getContactsForList).toHaveBeenCalledWith(5, { limit: 50, offset: 50 });
  });

  it.each(["-5", "0", "not-a-number"])("clamps an invalid page value (%s) to page 1", async (page) => {
    db.getListById.mockResolvedValue({ id: 5, name: "Newsletter" });
    db.getContactsForList.mockResolvedValue({ contacts: [], total: 0 });
    const app = await buildApp();
    await app.inject({ method: "GET", url: `/lists/5/contacts?page=${page}`, headers: AUTH_COOKIE });
    expect(db.getContactsForList).toHaveBeenCalledWith(5, { limit: 50, offset: 0 });
  });

  it("404s for a nonexistent list", async () => {
    db.getListById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/lists/999/contacts", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
  });
});
