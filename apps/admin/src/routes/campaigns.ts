import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enqueueCampaignSends } from "@carnival/campaigns";
import {
  createCampaign,
  deleteCampaign,
  finalizeCampaignIfDone,
  getAllCampaignsWithNames,
  getAllLists,
  getAllSegments,
  getAllTemplates,
  getCampaignById,
  getCampaignSendStats,
  getSubscribedContactIdsForList,
  getTemplateById,
  markCampaignSending,
  revertCampaignStatus,
  updateCampaign,
} from "@carnival/db";
import { groupSegmentsForPicker, resolveSegmentContactIds } from "@carnival/segments";
import { extractCampaignFieldNames } from "@carnival/templates";
import type { FastifyInstance } from "fastify";
import { campaignFieldLabel } from "../labels.js";
import { parseIdParam } from "../params.js";
import { sendPage } from "../render.js";
import { toEmbeddableJson } from "../view.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");

interface CampaignForm {
  name?: string;
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  templateId?: string;
  contentFields?: string;
  targetType?: string;
  listId?: string;
  segmentId?: string;
}

/** How the campaign form decides which widget to show for a `{{campaign.*}}`
 * field it doesn't otherwise know anything about — a naming convention
 * (checked here and mirrored in campaign-content-fields.js), not a schema.
 * A field with no name match keeps the plain single-line default. */
export function classifyCampaignFieldKind(name: string): "text" | "textarea" | "image" {
  const lower = name.toLowerCase();
  if (/imagen|foto|image/.test(lower)) return "image";
  if (/texto|condiciones|diferenciador|incentivo|descripcion/.test(lower)) return "textarea";
  return "text";
}

/** Same as Error, but remembers which wizard step the problem is actually
 * in — the form only has two, and every validation here is a step-1 field
 * except the per-template content fields (step 2). Without this, an error
 * from step 2 reloaded the form sitting on step 1, showing an error banner
 * that named raw {{campaign.*}} tags next to fields that all looked fine,
 * with no indication the real problem was one tab over. */
class CampaignFormError extends Error {
  constructor(
    message: string,
    public step: 1 | 2 = 1,
  ) {
    super(message);
  }
}

async function parseCampaignForm(body: CampaignForm) {
  const name = body.name?.trim();
  const subject = body.subject?.trim();
  const fromName = body.fromName?.trim();
  const fromEmail = body.fromEmail?.trim();
  if (!name) throw new Error("El nombre es obligatorio");
  if (!subject) throw new Error("El asunto es obligatorio");
  if (!fromName) throw new Error("El remitente (nombre) es obligatorio");
  if (!fromEmail) throw new Error("El remitente (email) es obligatorio");

  const templateId = body.templateId ? Number(body.templateId) : null;
  if (!templateId) throw new Error("Elegí un template para el contenido del correo");
  const template = await getTemplateById(templateId);
  if (!template) throw new Error("El template elegido ya no existe");

  let parsedFields: Record<string, unknown> = {};
  try {
    parsedFields = body.contentFields ? JSON.parse(body.contentFields) : {};
  } catch {
    throw new Error("Los campos de contenido de la campaña llegaron corruptos — volvé a intentar");
  }
  const requiredFields = extractCampaignFieldNames(template.htmlContent);
  const contentFields: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of requiredFields) {
    const value = typeof parsedFields[field] === "string" ? (parsedFields[field] as string).trim() : "";
    if (!value) missing.push(field);
    contentFields[field] = value;
  }
  if (missing.length > 0) {
    throw new CampaignFormError(
      `Completá estos campos antes de guardar: ${missing.map(campaignFieldLabel).join(", ")}`,
      2,
    );
  }

  const listId = body.targetType === "list" && body.listId ? Number(body.listId) : null;
  const segmentId = body.targetType === "segment" && body.segmentId ? Number(body.segmentId) : null;
  if (!listId && !segmentId) throw new Error("Elegí una lista o un segmento como destinatarios");

  return { name, subject, fromName, fromEmail, templateId, contentFields, listId, segmentId };
}

async function loadFormOptions() {
  const [templates, lists, segments] = await Promise.all([getAllTemplates(), getAllLists(), getAllSegments()]);
  return { templates, lists, segmentGroups: groupSegmentsForPicker(segments) };
}

async function computeAudienceCount(listId: number | null, segmentId: number | null): Promise<number> {
  if (listId) return (await getSubscribedContactIdsForList(listId)).length;
  if (segmentId) return (await resolveSegmentContactIds(segmentId)).length;
  return 0;
}

/** The error-reload path re-shows the form with the submitter's own input
 * (`request.body`), where `contentFields` is still the raw JSON string from
 * the hidden field — the happy path instead hands the view a real object
 * straight from the database. Normalizing here means the view/script never
 * has to care which path it came from. */
function normalizeContentFieldsForForm(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Re-renders the form with whatever the person just typed after a
 * validation error — but request.body's templateId/listId/segmentId arrive
 * as strings (every form-encoded field does), while form.eta picks the
 * selected <option> with `=== tpl.id` against the real numeric id from the
 * DB. Left un-converted, "7" === 7 is always false: no option ever matches,
 * so the browser silently falls back to whichever renders first — the
 * template/audience visibly "reset" to something the person never chose,
 * with no indication anything changed, right before they can resubmit and
 * actually save that wrong selection. */
function campaignForRedisplay(
  body: CampaignForm,
  extra: { id?: number; contentFields: Record<string, string> },
) {
  return {
    id: extra.id,
    ...body,
    templateId: body.templateId ? Number(body.templateId) : null,
    listId: body.listId ? Number(body.listId) : null,
    segmentId: body.segmentId ? Number(body.segmentId) : null,
    contentFields: extra.contentFields,
  };
}

export async function campaignsRoutes(app: FastifyInstance) {
  // Vanilla-JS island (no build step) — served the same explicit-route way as
  // template-editor.js and segment-builder.js, since there's no generic
  // static-file plugin registered for one-off assets like this.
  app.get("/campaign-content-fields.js", async (_request, reply) => {
    const js = readFileSync(path.join(publicDir, "campaign-content-fields.js"), "utf-8");
    reply.type("application/javascript; charset=utf-8").send(js);
  });

  app.get("/campaign-wizard.js", async (_request, reply) => {
    const js = readFileSync(path.join(publicDir, "campaign-wizard.js"), "utf-8");
    reply.type("application/javascript; charset=utf-8").send(js);
  });

  app.get<{ Querystring: { flash?: string } }>("/campaigns", async (request, reply) => {
    const campaigns = await getAllCampaignsWithNames();
    sendPage(request, reply, "campaigns/index", {
      title: "Campañas",
      activeNav: "campaigns",
      flash: request.query.flash ?? null,
      campaigns,
    });
  });

  app.get("/campaigns/new", async (request, reply) => {
    const options = await loadFormOptions();
    sendPage(request, reply, "campaigns/form", {
      title: "Nueva campaña",
      activeNav: "campaigns",
      campaign: null,
      contentFieldsJson: toEmbeddableJson({}),
      stats: null,
      error: null,
      ...options,
    });
  });

  app.post<{ Body: CampaignForm }>("/campaigns", async (request, reply) => {
    try {
      const campaign = await createCampaign(await parseCampaignForm(request.body));
      reply.redirect(`/campaigns/${campaign.id}/edit?flash=${encodeURIComponent("Campaña creada")}`);
    } catch (err) {
      const options = await loadFormOptions();
      const contentFields = normalizeContentFieldsForForm(request.body.contentFields);
      sendPage(request, reply, "campaigns/form", {
        title: "Nueva campaña",
        activeNav: "campaigns",
        campaign: campaignForRedisplay(request.body, { contentFields }),
        contentFieldsJson: toEmbeddableJson(contentFields),
        stats: null,
        error: (err as Error).message,
        errorStep: err instanceof CampaignFormError ? err.step : 1,
        ...options,
      });
    }
  });

  // Live "N contactos" preview as the campaign form's list/segment select
  // changes, before the campaign has even been saved.
  app.get<{ Querystring: { listId?: string; segmentId?: string } }>("/campaigns/audience-count", async (request, reply) => {
    const listId = request.query.listId ? Number(request.query.listId) : null;
    const segmentId = request.query.segmentId ? Number(request.query.segmentId) : null;
    const count = await computeAudienceCount(listId, segmentId);
    reply.send({ count });
  });

  // Powers the campaign form's dynamic content-fields section: which plain
  // fields (title, price, promo text...) the chosen template needs, derived
  // straight from its {{campaign.*}} tags — no separate schema to keep in
  // sync as templates gain or drop fields.
  app.get<{ Querystring: { templateId?: string } }>("/campaigns/template-fields", async (request, reply) => {
    const templateId = request.query.templateId ? Number(request.query.templateId) : null;
    const template = templateId ? await getTemplateById(templateId) : null;
    if (!template) {
      reply.send({ fields: [] });
      return;
    }
    const fields = extractCampaignFieldNames(template.htmlContent).map((name) => ({
      name,
      kind: classifyCampaignFieldKind(name),
    }));
    reply.send({ fields });
  });

  app.get<{ Params: { id: string }; Querystring: { flash?: string } }>("/campaigns/:id/edit", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    const campaign = await getCampaignById(id);
    if (!campaign) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    const [options, stats] = await Promise.all([loadFormOptions(), getCampaignSendStats(id)]);
    sendPage(request, reply, "campaigns/form", {
      title: "Editar campaña",
      activeNav: "campaigns",
      campaign,
      contentFieldsJson: toEmbeddableJson(campaign.contentFields ?? {}),
      stats,
      error: null,
      flash: request.query.flash ?? null,
      ...options,
    });
  });

  // Consumed by the "Enviar ahora" confirm dialog so it can name the real
  // number of recipients about to receive a real, one-way email — instead of
  // a generic "are you sure?" with no sense of blast radius.
  app.get<{ Params: { id: string } }>("/campaigns/:id/audience-count", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send({ error: "Campaña no encontrada" });
      return;
    }
    const campaign = await getCampaignById(id);
    if (!campaign) {
      reply.code(404).send({ error: "Campaña no encontrada" });
      return;
    }
    const count = await computeAudienceCount(campaign.listId, campaign.segmentId);
    reply.send({ count });
  });

  app.post<{ Params: { id: string }; Body: CampaignForm }>("/campaigns/:id", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    try {
      const existing = await getCampaignById(id);
      if (!existing) throw new Error("Campaña no encontrada");
      // The form's own <fieldset disabled> already keeps this from happening
      // through the UI — this is the actual enforcement, in case of a direct
      // POST. A campaign whose sends are already queued/dispatched/done had
      // its content locked in at that moment; letting the record keep
      // changing afterward would silently drift from what was really sent,
      // exactly the confusion Listmonk's own users report (github.com/knadh/
      // listmonk/issues/771 — edits to a sent campaign appear to work but
      // don't affect anything already delivered).
      if (existing.status !== "draft") {
        throw new Error("Esta campaña ya se envió (o se está enviando) — no se puede editar.");
      }
      await updateCampaign(id, await parseCampaignForm(request.body));
      reply.redirect(`/campaigns/${id}/edit?flash=${encodeURIComponent("Campaña actualizada")}`);
    } catch (err) {
      const options = await loadFormOptions();
      const contentFields = normalizeContentFieldsForForm(request.body.contentFields);
      sendPage(request, reply, "campaigns/form", {
        title: "Editar campaña",
        activeNav: "campaigns",
        campaign: campaignForRedisplay(request.body, { id, contentFields }),
        contentFieldsJson: toEmbeddableJson(contentFields),
        stats: null,
        error: (err as Error).message,
        errorStep: err instanceof CampaignFormError ? err.step : 1,
        ...options,
      });
    }
  });

  // Copies everything a new campaign needs to reuse ("same promo, new week")
  // except anything tied to the specific send that already happened —
  // always a fresh draft, never the original's status/sentAt, so it goes
  // through the normal create→review→send flow again rather than looking
  // like it was already sent.
  app.post<{ Params: { id: string } }>("/campaigns/:id/duplicate", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    const original = await getCampaignById(id);
    if (!original) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    const copy = await createCampaign({
      name: `${original.name} (copia)`,
      subject: original.subject,
      fromName: original.fromName,
      fromEmail: original.fromEmail,
      templateId: original.templateId,
      contentFields: (original.contentFields as Record<string, string>) ?? {},
      listId: original.listId,
      segmentId: original.segmentId,
    });
    reply.redirect(`/campaigns/${copy.id}/edit?flash=${encodeURIComponent("Campaña duplicada — revisala antes de enviar")}`);
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/delete", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    await deleteCampaign(id);
    reply.redirect(`/campaigns?flash=${encodeURIComponent("Campaña eliminada")}`);
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/send", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    const campaignBeforeSend = await getCampaignById(id);
    if (!campaignBeforeSend) {
      reply.code(404).send("Campaña no encontrada");
      return;
    }
    try {
      // Without this, re-POSTing this route on a campaign that's already
      // sending/sent (a double-click, a browser back-and-resubmit, or a
      // second deliberate click before the page reloads) silently re-runs
      // enqueueCampaignSends — onConflictDoNothing means anyone already sent
      // to is skipped, but anyone who's newly joined a dynamic list/segment
      // since the original send has no existing row and WOULD get a real,
      // unannounced send. The "sent campaigns are locked" guarantee added
      // for the edit route needs the exact same guard here — a locked
      // campaign that can still be told to send again isn't actually locked.
      if (campaignBeforeSend.status !== "draft") {
        throw new Error("Esta campaña ya se envió (o se está enviando) — no se puede volver a mandar.");
      }
      await markCampaignSending(id);
      const { queuedCount, audienceSize } = await enqueueCampaignSends(id);
      // Covers the one case no worker event ever fires for: a zero-contact
      // audience, which would otherwise leave the campaign at "sending"
      // forever with nothing left to do. A non-empty audience just re-checks
      // (and no-ops, since sends are still queued) — harmless.
      await finalizeCampaignIfDone(id);
      reply.redirect(
        `/campaigns/${id}/edit?flash=${encodeURIComponent(
          `Encolados ${queuedCount} envíos (${audienceSize} destinatarios matcheados)`,
        )}`,
      );
    } catch (err) {
      // Without this, a failure to even enqueue (e.g. Redis unreachable)
      // leaves the campaign at "sending" forever — indistinguishable from a
      // real send in flight, with no worker event ever coming to resolve it.
      await revertCampaignStatus(id, campaignBeforeSend.status);
      const campaign = await getCampaignById(id);
      const [options, stats] = await Promise.all([loadFormOptions(), getCampaignSendStats(id)]);
      sendPage(request, reply, "campaigns/form", {
        title: "Editar campaña",
        activeNav: "campaigns",
        campaign,
        contentFieldsJson: toEmbeddableJson(campaign?.contentFields ?? {}),
        stats,
        error: (err as Error).message,
        ...options,
      });
    }
  });
}
