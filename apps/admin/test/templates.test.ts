import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getAllTemplates: vi.fn(),
  getTemplateById: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
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
  db.getAllTemplates.mockResolvedValue([]);
});

describe("templates CRUD", () => {
  it("creates a template", async () => {
    db.createTemplate.mockResolvedValue({ id: 1 });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/templates",
      headers: AUTH_COOKIE,
      payload: { name: "Bienvenida", htmlContent: "<p>Hola {{contact.firstName}}</p>" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/templates/1/edit?flash=");
    expect(db.createTemplate).toHaveBeenCalledWith({
      name: "Bienvenida",
      htmlContent: "<p>Hola {{contact.firstName}}</p>",
    });
  });

  it("requires html content", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/templates",
      headers: AUTH_COOKIE,
      payload: { name: "Vacío", htmlContent: "  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("El contenido HTML es obligatorio");
    expect(db.createTemplate).not.toHaveBeenCalled();
  });

  it("rejects a template using raw ({{{...}}}) output at save time", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/templates",
      headers: AUTH_COOKIE,
      payload: { name: "Inseguro", htmlContent: "{{{contact.firstName}}}" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("sin escapar");
    expect(db.createTemplate).not.toHaveBeenCalled();
  });

  it("rejects a template using an unknown merge tag at save time", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/templates",
      headers: AUTH_COOKIE,
      payload: { name: "Typo", htmlContent: "Hola {{contact.FirstName}}" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("campo desconocido");
    expect(db.createTemplate).not.toHaveBeenCalled();
  });

  it("rejects a template with an unresolved bracket placeholder at save time", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/templates",
      headers: AUTH_COOKIE,
      payload: { name: "A medio escribir", htmlContent: "Descuento: [DESCUENTO]% en tu próximo pedido" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("texto de relleno sin completar");
    expect(db.createTemplate).not.toHaveBeenCalled();
  });

  it("returns 404 editing a missing template", async () => {
    db.getTemplateById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/999/edit", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
  });

  it("returns a clean 404 for a non-numeric id instead of a raw DB error", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/not-a-number/edit", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
    expect(db.getTemplateById).not.toHaveBeenCalled();
  });
});

describe("GET /templates/:id/preview", () => {
  it("renders the saved template with sample contact data", async () => {
    db.getTemplateById.mockResolvedValue({
      id: 1,
      name: "Bienvenida",
      htmlContent: "<p>Hola {{contact.firstName}}, bajate en {{unsubscribeUrl}}</p>",
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/1/preview", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Hola María");
    expect(res.body).toContain("#vista-previa");
  });

  it("returns 404 for a missing template", async () => {
    db.getTemplateById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/999/preview", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
  });

  it("embeds the email in an iframe with a mobile/desktop width toggle", async () => {
    db.getTemplateById.mockResolvedValue({ id: 1, name: "Bienvenida", htmlContent: "<p>Hola</p>" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/1/preview", headers: AUTH_COOKIE });
    expect(res.body).toContain('data-width="600"');
    expect(res.body).toContain('data-width="375"');
    expect(res.body).toContain("<iframe");
  });

  // Nothing in a real template should ever need to run script/submit a
  // form/navigate the parent admin page — sandbox="" blocks all of that
  // even if renderTemplate's own raw-output guard were ever bypassed.
  it("sandboxes the preview iframe", async () => {
    db.getTemplateById.mockResolvedValue({ id: 1, name: "Bienvenida", htmlContent: "<p>Hola</p>" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/1/preview", headers: AUTH_COOKIE });
    expect(res.body).toContain('sandbox=""');
  });

  // srcdoc is an HTML attribute holding markup — an un-escaped " in the
  // email's own content (a quoted attribute value, a curly quote typed as a
  // straight one) would otherwise close the iframe's srcdoc attribute early
  // and dump the rest of the email as literal text in the page instead of
  // rendering it inside the frame.
  it("escapes double quotes and ampersands in the email before embedding it in the iframe's srcdoc", async () => {
    db.getTemplateById.mockResolvedValue({
      id: 1,
      name: "Bienvenida",
      htmlContent: '<p title="Carnival & co">Hola</p>',
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/templates/1/preview", headers: AUTH_COOKIE });
    expect(res.body).toContain("&amp;");
    expect(res.body).toContain("&quot;");
    expect(res.body).not.toContain('title="Carnival & co"');
  });
});
