import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getAllCampaignsWithNames: vi.fn(),
  getAllTemplates: vi.fn(),
  getAllLists: vi.fn(),
  getAllSegments: vi.fn(),
  getCampaignById: vi.fn(),
  getCampaignSendStats: vi.fn(),
  getTemplateById: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
  markCampaignSending: vi.fn(),
  revertCampaignStatus: vi.fn(),
  getSubscribedContactIdsForList: vi.fn(),
  finalizeCampaignIfDone: vi.fn(),
}));
vi.mock("@carnival/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/db")>()),
  ...db,
}));

const campaignsPkg = vi.hoisted(() => ({ enqueueCampaignSends: vi.fn() }));
vi.mock("@carnival/campaigns", () => campaignsPkg);

const segmentsPkg = vi.hoisted(() => ({ resolveSegmentContactIds: vi.fn() }));
vi.mock("@carnival/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/segments")>()),
  ...segmentsPkg,
}));

const { buildApp } = await import("../src/app.js");

const AUTH_COOKIE = { cookie: "carnival_admin_session=validtoken" };

beforeEach(() => {
  vi.clearAllMocks();
  db.getSessionUser.mockResolvedValue({ userId: 1, email: "owner@carnival.test" });
  db.getAllCampaignsWithNames.mockResolvedValue([]);
  db.getAllTemplates.mockResolvedValue([]);
  db.getAllLists.mockResolvedValue([{ id: 5, name: "Newsletter" }]);
  db.getAllSegments.mockResolvedValue([{ id: 9, name: "VIPs" }]);
  db.getTemplateById.mockResolvedValue({ id: 7, name: "Template de prueba", htmlContent: "<p>Hola {{contact.firstName}}</p>" });
});

describe("POST /campaigns", () => {
  const validPayload = {
    name: "Promo otoño",
    subject: "Ofertas de la semana",
    fromName: "Carnival",
    fromEmail: "no-reply@example.com",
    templateId: "7",
    targetType: "list",
    listId: "5",
  };

  it("creates a campaign targeting a list", async () => {
    db.createCampaign.mockResolvedValue({ id: 10 });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns", headers: AUTH_COOKIE, payload: validPayload });
    expect(res.statusCode).toBe(302);
    expect(db.createCampaign).toHaveBeenCalledWith({
      name: "Promo otoño",
      subject: "Ofertas de la semana",
      fromName: "Carnival",
      fromEmail: "no-reply@example.com",
      templateId: 7,
      contentFields: {},
      listId: 5,
      segmentId: null,
    });
  });

  it("requires a template", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, templateId: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Elegí un template");
    expect(db.createCampaign).not.toHaveBeenCalled();
  });

  it("creates a campaign targeting a segment", async () => {
    db.createCampaign.mockResolvedValue({ id: 11 });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, targetType: "segment", segmentId: "9", listId: "" },
    });
    expect(res.statusCode).toBe(302);
    expect(db.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ listId: null, segmentId: 9 }),
    );
  });

  it("requires a list or a segment", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, targetType: "list", listId: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Elegí una lista o un segmento");
    expect(db.createCampaign).not.toHaveBeenCalled();
  });

  it("rejects targetType=segment left on its blank placeholder option, not a silently browser-picked segment", async () => {
    // Regression test for the live-verified UX finding: with no blank option
    // in the Segmento <select>, the browser would auto-select whatever
    // segment happened to be first, so toggling to "Segmento" and submitting
    // without touching the dropdown could enqueue a real, unchosen audience.
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, targetType: "segment", segmentId: "", listId: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Elegí una lista o un segmento");
    expect(db.createCampaign).not.toHaveBeenCalled();
  });
});

describe("campaign content fields ({{campaign.*}} tags)", () => {
  const validPayload = {
    name: "Promo otoño",
    subject: "Ofertas de la semana",
    fromName: "Carnival",
    fromEmail: "no-reply@example.com",
    templateId: "7",
    targetType: "list",
    listId: "5",
  };

  it("rejects saving when the template's {{campaign.*}} fields are left blank", async () => {
    db.getTemplateById.mockResolvedValue({
      id: 7,
      name: "Newsletter general",
      htmlContent: "<p>{{campaign.titulo}}</p><p>{{campaign.precio}}</p>",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, contentFields: JSON.stringify({ titulo: "Hamburguesas" }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Completá estos campos antes de guardar: Precio");
    expect(db.createCampaign).not.toHaveBeenCalled();
  });

  // A content-field error is the one validation failure that actually lives
  // on step 2 — reloading on step 1 (the default) would show the error
  // banner next to fields that all look fine, with nothing pointing at the
  // real problem one tab over.
  it("reopens the wizard on step 2 when a content field is missing", async () => {
    db.getTemplateById.mockResolvedValue({
      id: 7,
      name: "Newsletter general",
      htmlContent: "<p>{{campaign.titulo}}</p><p>{{campaign.precio}}</p>",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, contentFields: JSON.stringify({ titulo: "Hamburguesas" }) },
    });
    expect(res.body).toContain('data-initial-step="2"');
  });

  it("reopens the wizard on step 1 for a step-1 field error (e.g. a missing name)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, name: "" },
    });
    expect(res.body).toContain('data-initial-step="1"');
  });

  // request.body's templateId/listId arrive as strings (every form-encoded
  // field does) — form.eta picks the selected <option> by comparing against
  // the real numeric id from the DB with `===`. Re-displaying the raw string
  // straight from request.body made that comparison always false: no option
  // ever matched, and the browser silently fell back to whichever template/
  // list happened to render first — reset with zero indication, right before
  // the person fixes the actual error and saves that wrong selection for real.
  it("keeps the chosen template and list selected when re-displaying the form after a validation error", async () => {
    db.getAllTemplates.mockResolvedValue([
      { id: 3, name: "Wrong template" },
      { id: 7, name: "Newsletter general" },
    ]);
    db.getAllLists.mockResolvedValue([
      { id: 2, name: "Wrong list" },
      { id: 5, name: "Newsletter" },
    ]);
    db.getTemplateById.mockResolvedValue({
      id: 7,
      name: "Newsletter general",
      htmlContent: "<p>{{campaign.titulo}}</p><p>{{campaign.precio}}</p>",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: { ...validPayload, contentFields: JSON.stringify({ titulo: "Hamburguesas" }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="7" selected');
    expect(res.body).toContain('value="5" selected');
    expect(res.body).not.toContain('value="3" selected');
    expect(res.body).not.toContain('value="2" selected');
  });

  it("saves the filled-in content fields alongside the campaign", async () => {
    db.getTemplateById.mockResolvedValue({
      id: 7,
      name: "Newsletter general",
      htmlContent: "<p>{{campaign.titulo}}</p><p>{{campaign.precio}}</p>",
    });
    db.createCampaign.mockResolvedValue({ id: 15 });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/campaigns",
      headers: AUTH_COOKIE,
      payload: {
        ...validPayload,
        contentFields: JSON.stringify({ titulo: "Hamburguesas", precio: "11,90 € / kg" }),
      },
    });
    expect(res.statusCode).toBe(302);
    expect(db.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ contentFields: { titulo: "Hamburguesas", precio: "11,90 € / kg" } }),
    );
  });

  it("a template with no {{campaign.*}} tags needs no content fields at all", async () => {
    db.getTemplateById.mockResolvedValue({ id: 7, name: "Simple", htmlContent: "<p>Hola {{contact.firstName}}</p>" });
    db.createCampaign.mockResolvedValue({ id: 16 });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns", headers: AUTH_COOKIE, payload: validPayload });
    expect(res.statusCode).toBe(302);
    expect(db.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ contentFields: {} }));
  });
});

describe("POST /campaigns/:id (update)", () => {
  const validPayload = {
    name: "Promo otoño",
    subject: "Ofertas de la semana",
    fromName: "Carnival",
    fromEmail: "no-reply@example.com",
    templateId: "7",
    targetType: "list",
    listId: "5",
  };

  it("updates a draft campaign", async () => {
    db.getCampaignById.mockResolvedValue({ id: 30, status: "draft" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/30", headers: AUTH_COOKIE, payload: validPayload });
    expect(res.statusCode).toBe(302);
    expect(db.updateCampaign).toHaveBeenCalled();
  });

  // A sent campaign's content is already locked in by what actually went
  // out — letting the stored record keep changing afterward would silently
  // drift from what was really delivered (github.com/knadh/listmonk/issues/771).
  it.each(["sending", "sent"])("rejects editing a %s campaign", async (status) => {
    db.getCampaignById.mockResolvedValue({ id: 31, status });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/31", headers: AUTH_COOKIE, payload: validPayload });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ya se envió");
    expect(db.updateCampaign).not.toHaveBeenCalled();
  });
});

describe("public JS islands", () => {
  // There's no generic static-file plugin registered for apps/admin's
  // one-off vanilla-JS assets — each needs its own explicit route (see
  // campaigns.ts). Dropping a new file into public/ without also wiring up
  // its route is a real, silent-until-you-click-it mistake: the page loads
  // fine, the <script src> 404s quietly, and whatever that script was
  // supposed to wire up (here, the campaign wizard's step navigation) just
  // never does anything.
  it.each(["/campaign-content-fields.js", "/campaign-wizard.js"])("serves %s", async (url) => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url, headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
  });
});

describe("GET /campaigns/template-fields", () => {
  it("lists the campaign fields a template needs, with a widget kind for each", async () => {
    db.getTemplateById.mockResolvedValue({
      id: 7,
      name: "Newsletter general",
      htmlContent: "<p>{{campaign.titulo}}</p><img src=\"{{campaign.imagen}}\"><p>{{campaign.texto}}</p>",
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/template-fields?templateId=7", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      fields: [
        { name: "titulo", kind: "text" },
        { name: "imagen", kind: "image" },
        { name: "texto", kind: "textarea" },
      ],
    });
  });

  it("returns an empty list without a templateId", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/template-fields", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ fields: [] });
  });
});

describe("POST /campaigns/:id/duplicate", () => {
  it("creates a new draft copying everything except status/sentAt, and redirects to edit it", async () => {
    db.getCampaignById.mockResolvedValue({
      id: 8,
      name: "Promo otoño",
      subject: "Ofertas de la semana",
      fromName: "Carnival",
      fromEmail: "no-reply@example.com",
      templateId: 7,
      contentFields: { titulo: "Hamburguesas" },
      listId: 5,
      segmentId: null,
      status: "sent",
    });
    db.createCampaign.mockResolvedValue({ id: 9 });

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/8/duplicate", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/campaigns/9/edit?flash=" + encodeURIComponent("Campaña duplicada — revisala antes de enviar"));
    expect(db.createCampaign).toHaveBeenCalledWith({
      name: "Promo otoño (copia)",
      subject: "Ofertas de la semana",
      fromName: "Carnival",
      fromEmail: "no-reply@example.com",
      templateId: 7,
      contentFields: { titulo: "Hamburguesas" },
      listId: 5,
      segmentId: null,
    });
  });

  it("404s for a nonexistent campaign", async () => {
    db.getCampaignById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/999/duplicate", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
    expect(db.createCampaign).not.toHaveBeenCalled();
  });
});

describe("POST /campaigns/:id/send", () => {
  it("marks the campaign sending, enqueues, and redirects with a flash showing counts", async () => {
    campaignsPkg.enqueueCampaignSends.mockResolvedValue({ queuedCount: 3, audienceSize: 5 });
    db.getCampaignById.mockResolvedValue({ id: 12, status: "draft" });
    db.getCampaignSendStats.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/12/send", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(302);
    expect(db.markCampaignSending).toHaveBeenCalledWith(12);
    expect(campaignsPkg.enqueueCampaignSends).toHaveBeenCalledWith(12);
    expect(res.headers.location).toContain(encodeURIComponent("Encolados 3"));
  });

  it("calls finalizeCampaignIfDone right after enqueueing — the only way a zero-audience send ever resolves out of 'sending'", async () => {
    campaignsPkg.enqueueCampaignSends.mockResolvedValue({ queuedCount: 0, audienceSize: 0 });
    db.getCampaignById.mockResolvedValue({ id: 14, status: "draft" });
    db.getCampaignSendStats.mockResolvedValue([]);

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/campaigns/14/send", headers: AUTH_COOKIE });

    expect(db.finalizeCampaignIfDone).toHaveBeenCalledWith(14);
  });

  it("shows an error on the edit page if enqueueing fails instead of crashing", async () => {
    campaignsPkg.enqueueCampaignSends.mockRejectedValue(new Error("REDIS_URL is not set"));
    db.getCampaignById.mockResolvedValue({ id: 13, name: "x", status: "draft" });
    db.getCampaignSendStats.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/13/send", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("REDIS_URL is not set");
  });

  it("reverts the campaign back to its previous status when enqueueing fails, instead of leaving it stuck at 'sending'", async () => {
    campaignsPkg.enqueueCampaignSends.mockRejectedValue(new Error("REDIS_URL is not set"));
    db.getCampaignById.mockResolvedValue({ id: 13, name: "x", status: "draft" });
    db.getCampaignSendStats.mockResolvedValue([]);

    const app = await buildApp();
    await app.inject({ method: "POST", url: "/campaigns/13/send", headers: AUTH_COOKIE });

    expect(db.markCampaignSending).toHaveBeenCalledWith(13);
    expect(db.revertCampaignStatus).toHaveBeenCalledWith(13, "draft");
  });

  // Re-POSTing this route on a campaign that's already sending/sent (a
  // double-click, a browser back-and-resubmit) used to silently re-run
  // enqueueCampaignSends — harmless for contacts already sent to
  // (onConflictDoNothing), but a real, unannounced send to anyone who's
  // newly joined a dynamic list/segment since the original send.
  it.each(["sending", "sent"])("rejects re-sending a %s campaign", async (status) => {
    db.getCampaignById.mockResolvedValue({ id: 15, name: "x", status });
    db.getCampaignSendStats.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/campaigns/15/send", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ya se envió");
    expect(db.markCampaignSending).not.toHaveBeenCalled();
    expect(campaignsPkg.enqueueCampaignSends).not.toHaveBeenCalled();
  });
});

describe("GET /campaigns/audience-count", () => {
  it("counts subscribed contacts for a listId query param", async () => {
    db.getSubscribedContactIdsForList.mockResolvedValue([1, 2, 3, 4]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/audience-count?listId=5", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 4 });
    expect(db.getSubscribedContactIdsForList).toHaveBeenCalledWith(5);
  });

  it("counts matching contacts for a segmentId query param", async () => {
    segmentsPkg.resolveSegmentContactIds.mockResolvedValue([1]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/audience-count?segmentId=9", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 1 });
    expect(segmentsPkg.resolveSegmentContactIds).toHaveBeenCalledWith(9);
  });

  it("returns 0 when neither listId nor segmentId is given", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/audience-count", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 0 });
    expect(db.getSubscribedContactIdsForList).not.toHaveBeenCalled();
    expect(segmentsPkg.resolveSegmentContactIds).not.toHaveBeenCalled();
  });
});

describe("GET /campaigns/:id/audience-count", () => {
  it("counts subscribed contacts for a list-targeted campaign", async () => {
    db.getCampaignById.mockResolvedValue({ id: 20, listId: 5, segmentId: null });
    db.getSubscribedContactIdsForList.mockResolvedValue([1, 2, 3]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/20/audience-count", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 3 });
    expect(db.getSubscribedContactIdsForList).toHaveBeenCalledWith(5);
    expect(segmentsPkg.resolveSegmentContactIds).not.toHaveBeenCalled();
  });

  it("counts matching contacts for a segment-targeted campaign", async () => {
    db.getCampaignById.mockResolvedValue({ id: 21, listId: null, segmentId: 9 });
    segmentsPkg.resolveSegmentContactIds.mockResolvedValue([1, 2]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/21/audience-count", headers: AUTH_COOKIE });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 2 });
    expect(segmentsPkg.resolveSegmentContactIds).toHaveBeenCalledWith(9);
  });

  it("returns 404 for a missing campaign", async () => {
    db.getCampaignById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/999/audience-count", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a non-numeric id instead of a raw DB error", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/campaigns/not-a-number/audience-count", headers: AUTH_COOKIE });
    expect(res.statusCode).toBe(404);
    expect(db.getCampaignById).not.toHaveBeenCalled();
  });
});
