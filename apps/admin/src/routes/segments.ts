import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSegment,
  deleteSegment,
  getAllLists,
  getAllSegments,
  getDistinctAttributeValues,
  getSegmentById,
  updateSegment,
} from "@carnival/db";
import {
  assertRuleGroupSize,
  countContactsMatchingRule,
  resolveSegmentContactsPage,
  ruleGroupSchema,
} from "@carnival/segments";
import type { FastifyInstance } from "fastify";
import { isForeignKeyViolation } from "../dbErrors.js";
import { parseIdParam } from "../params.js";
import { sendPage } from "../render.js";
import { toEmbeddableJson } from "../view.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const CONTACTS_PAGE_SIZE = 50;

interface SegmentForm {
  name?: string;
  definition?: string;
}

// Every contact.attributes key the segment builder offers as a dropdown of
// known values instead of a free-text field. Add a key here as soon as
// something new starts populating it (see packages/woocommerce's mappers).
async function getKnownAttributeValues() {
  const [city, comunidadAutonoma] = await Promise.all([
    getDistinctAttributeValues("city"),
    getDistinctAttributeValues("comunidadAutonoma"),
  ]);
  return { city, comunidadAutonoma };
}

function parseSegmentForm(body: SegmentForm) {
  const name = body.name?.trim();
  if (!name) throw new Error("El nombre es obligatorio");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.definition ?? "");
  } catch {
    throw new Error("La definición del segmento no es un JSON válido");
  }
  assertRuleGroupSize(parsedJson);
  const result = ruleGroupSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Definición de segmento inválida: ${result.error.issues[0]?.message ?? "error desconocido"}`);
  }
  return { name, definition: result.data };
}

export async function segmentsRoutes(app: FastifyInstance) {
  // Vanilla-JS island (no build step) that renders/edits the rule-tree — served
  // as a plain static file rather than pulling in @fastify/static for one asset.
  app.get("/segment-builder.js", async (_request, reply) => {
    const js = readFileSync(path.join(publicDir, "segment-builder.js"), "utf-8");
    reply.type("application/javascript; charset=utf-8").send(js);
  });

  // Powers the segment builder's live "N contactos" preview as rules change,
  // before the segment is even saved — so validates/counts against the raw
  // definition instead of a saved segment id.
  app.post<{ Body: SegmentForm }>("/segments/preview-count", async (request, reply) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(request.body.definition ?? "");
      assertRuleGroupSize(parsedJson);
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
    const result = ruleGroupSchema.safeParse(parsedJson);
    if (!result.success) {
      reply.code(400).send({ error: result.error.issues[0]?.message ?? "Definición inválida" });
      return;
    }
    const count = await countContactsMatchingRule(result.data);
    reply.send({ count });
  });

  app.get<{ Querystring: { flash?: string } }>("/segments", async (request, reply) => {
    const segments = await getAllSegments();
    sendPage(request, reply, "segments/index", {
      title: "Segmentos",
      activeNav: "segments",
      flash: request.query.flash ?? null,
      segments,
    });
  });

  app.get("/segments/new", async (request, reply) => {
    const lists = await getAllLists();
    sendPage(request, reply, "segments/form", {
      title: "Nuevo segmento",
      activeNav: "segments",
      segment: null,
      definitionJson: toEmbeddableJson({ glue: "and", conditions: [] }),
      listsJson: toEmbeddableJson(lists),
      attributeValuesJson: toEmbeddableJson(await getKnownAttributeValues()),
      error: null,
    });
  });

  app.post<{ Body: SegmentForm }>("/segments", async (request, reply) => {
    try {
      const segment = await createSegment(parseSegmentForm(request.body));
      // Straight into continued editing, not back to the index — matches
      // campaigns' create flow. Bouncing to the index after create meant an
      // extra "Editar" click to keep working on what you just made, right
      // when you're most likely to want to (e.g. double-check the rule
      // before using it in a real send).
      reply.redirect(`/segments/${segment.id}/edit?flash=${encodeURIComponent("Segmento creado")}`);
    } catch (err) {
      const lists = await getAllLists();
      sendPage(request, reply, "segments/form", {
        title: "Nuevo segmento",
        activeNav: "segments",
        segment: request.body,
        definitionJson: toEmbeddableJson(safeParseOrEmpty(request.body.definition)),
        listsJson: toEmbeddableJson(lists),
        attributeValuesJson: toEmbeddableJson(await getKnownAttributeValues()),
        error: (err as Error).message,
      });
    }
  });

  app.get<{ Params: { id: string } }>("/segments/:id/edit", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    const segment = id === null ? null : await getSegmentById(id);
    if (!segment) {
      reply.code(404).send("Segmento no encontrado");
      return;
    }
    const lists = await getAllLists();
    sendPage(request, reply, "segments/form", {
      title: "Editar segmento",
      activeNav: "segments",
      segment,
      definitionJson: toEmbeddableJson(segment.definition),
      listsJson: toEmbeddableJson(lists),
      attributeValuesJson: toEmbeddableJson(await getKnownAttributeValues()),
      error: null,
    });
  });

  app.post<{ Params: { id: string }; Body: SegmentForm }>("/segments/:id", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Segmento no encontrado");
      return;
    }
    try {
      await updateSegment(id, parseSegmentForm(request.body));
      reply.redirect(`/segments?flash=${encodeURIComponent("Segmento actualizado")}`);
    } catch (err) {
      const lists = await getAllLists();
      sendPage(request, reply, "segments/form", {
        title: "Editar segmento",
        activeNav: "segments",
        segment: { id, ...request.body },
        definitionJson: toEmbeddableJson(safeParseOrEmpty(request.body.definition)),
        listsJson: toEmbeddableJson(lists),
        attributeValuesJson: toEmbeddableJson(await getKnownAttributeValues()),
        error: (err as Error).message,
      });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>("/segments/:id/contacts", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    const segment = id === null ? null : await getSegmentById(id);
    if (!segment) {
      reply.code(404).send("Segmento no encontrado");
      return;
    }
    const page = Math.max(1, Number(request.query.page) || 1);
    const { contacts, total } = await resolveSegmentContactsPage(id!, {
      limit: CONTACTS_PAGE_SIZE,
      offset: (page - 1) * CONTACTS_PAGE_SIZE,
    });
    sendPage(request, reply, "segments/contacts", {
      title: `Contactos de "${segment.name}"`,
      activeNav: "segments",
      segment,
      contacts,
      total,
      page,
      pageSize: CONTACTS_PAGE_SIZE,
    });
  });

  app.post<{ Params: { id: string } }>("/segments/:id/delete", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Segmento no encontrado");
      return;
    }
    try {
      await deleteSegment(id);
      reply.redirect(`/segments?flash=${encodeURIComponent("Segmento eliminado")}`);
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
      const segment = await getSegmentById(id);
      const lists = await getAllLists();
      sendPage(request, reply, "segments/form", {
        title: "Editar segmento",
        activeNav: "segments",
        segment,
        definitionJson: toEmbeddableJson(segment?.definition ?? {}),
        listsJson: toEmbeddableJson(lists),
        attributeValuesJson: toEmbeddableJson(await getKnownAttributeValues()),
        error: "No se puede borrar: todavía hay una o más campañas que usan este segmento.",
      });
    }
  });
}

function safeParseOrEmpty(definition: string | undefined): unknown {
  try {
    return definition ? JSON.parse(definition) : { glue: "and", conditions: [] };
  } catch {
    return { glue: "and", conditions: [] };
  }
}
