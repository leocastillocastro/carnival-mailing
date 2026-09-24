import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTemplate, deleteTemplate, getAllTemplates, getTemplateById, updateTemplate } from "@carnival/db";
import {
  assertKnownMergeTags,
  assertNoRawOutput,
  assertNoUnresolvedPlaceholders,
  extractCampaignFieldNames,
  renderTemplate,
} from "@carnival/templates";
import type { FastifyInstance } from "fastify";
import { isForeignKeyViolation } from "../dbErrors.js";
import { parseIdParam } from "../params.js";
import { sendPage } from "../render.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");

interface TemplateForm {
  name?: string;
  htmlContent?: string;
}

// srcdoc is an HTML attribute holding markup — & and " need entity-escaping
// so the browser doesn't read the email's own content as ending the
// attribute early; unlike element text content, this is not something Eta's
// own auto-escaping (meant for `<%= %>` inside element bodies) covers.
function escapeForSrcdocAttribute(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Sample values for a template's own {{campaign.*}} fields, keyed by field
// name (extractCampaignFieldNames tells us which ones a given template
// actually uses) — without these the preview below rendered every campaign
// field blank: no title, no price, a broken image (src=""), and even a
// dangling "Válido hasta el ." with no date. A self-contained SVG data URI
// for the photo avoids depending on any external placeholder service.
const PLACEHOLDER_IMAGE_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1NjAiIGhlaWdodD0iMzYwIj48cmVjdCB3aWR0aD0iNTYwIiBoZWlnaHQ9IjM2MCIgZmlsbD0iI2U5ZTZkZSIvPjx0ZXh0IHg9IjI4MCIgeT0iMTg1IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIyMCIgZmlsbD0iIzZiNjU1OCIgdGV4dC1hbmNob3I9Im1pZGRsZSI+Rm90byBkZSBlamVtcGxvPC90ZXh0Pjwvc3ZnPgo=";

const SAMPLE_CAMPAIGN_VALUES: Record<string, string> = {
  eyebrow: "Oferta de la semana",
  titulo: "Entrecot importado",
  precio: "24,90€/kg",
  preheader: "Esta semana: entrecot importado",
  imagen: PLACEHOLDER_IMAGE_DATA_URI,
  texto: "Este es un texto de ejemplo para la vista previa — así se va a ver el cuerpo del mensaje.",
  fecha: "31/12",
  descuento: "15%",
};

// The real preview route below returns the email's own full <!doctype html>
// document directly (deliberately unstyled by the admin's own layout, so it
// shows exactly what a recipient would see) — an iframe is the only way to
// add a device-width toggle around that without editing the email markup
// itself. No cross-client rendering (that's a paid service like Litmus); a
// plain width change is enough to catch the actual, common failure mode —
// text/images overflowing or a two-column layout not stacking on a phone.
function wrapPreviewWithDeviceToggle(emailHtml: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vista previa</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #f4f4f4; }
  .preview-toolbar { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; background: #1e2a38; }
  .preview-toolbar button { background: none; border: 1px solid #4a5568; color: #d8dde1; padding: 0.4rem 0.9rem; border-radius: 0.3rem; cursor: pointer; font: inherit; font-size: 0.85rem; }
  .preview-toolbar button.active { background: #b5342a; border-color: #b5342a; color: #fff; }
  .preview-frame-wrap { display: flex; justify-content: center; padding: 2rem 1rem; }
  iframe { border: 1px solid #ddd; background: #fff; height: 85vh; width: 600px; max-width: 100%; transition: width 0.15s ease; }
</style>
</head>
<body>
  <div class="preview-toolbar">
    <button type="button" class="active" data-width="600">Escritorio</button>
    <button type="button" data-width="375">Celular</button>
  </div>
  <div class="preview-frame-wrap">
    <!-- sandbox="" (no allow-* tokens at all): renderTemplate already blocks
         raw/unescaped merge-tag output before a template can be saved, so
         this shouldn't ever see real script content — but a static preview
         has zero legitimate need to run scripts, submit forms, or navigate
         the parent page either, so it's not left able to even if that
         guarantee were ever wrong. -->
    <iframe id="preview-frame" sandbox="" srcdoc="${escapeForSrcdocAttribute(emailHtml)}"></iframe>
  </div>
  <script>
    var frame = document.getElementById("preview-frame");
    document.querySelectorAll("[data-width]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        frame.style.width = btn.dataset.width + "px";
        document.querySelectorAll("[data-width]").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
      });
    });
  </script>
</body>
</html>`;
}

function parseTemplateForm(body: TemplateForm) {
  const name = body.name?.trim();
  const htmlContent = body.htmlContent?.trim();
  if (!name) throw new Error("El nombre es obligatorio");
  if (!htmlContent) throw new Error("El contenido HTML es obligatorio");
  // Fail at save time, with a message the template author can act on —
  // not days later when a campaign send hits the same check in renderTemplate.
  assertNoRawOutput(htmlContent);
  assertKnownMergeTags(htmlContent);
  assertNoUnresolvedPlaceholders(htmlContent);
  return { name, htmlContent };
}

export async function templatesRoutes(app: FastifyInstance) {
  // Vanilla-JS island (no build step) that turns the form's textarea into a
  // GrapesJS block editor — served the same way as segment-builder.js.
  app.get("/template-editor.js", async (_request, reply) => {
    const js = readFileSync(path.join(publicDir, "template-editor.js"), "utf-8");
    reply.type("application/javascript; charset=utf-8").send(js);
  });

  app.get<{ Querystring: { flash?: string } }>("/templates", async (request, reply) => {
    const templates = await getAllTemplates();
    sendPage(request, reply, "templates/index", {
      title: "Templates",
      activeNav: "templates",
      flash: request.query.flash ?? null,
      templates,
    });
  });

  app.get("/templates/new", async (request, reply) => {
    sendPage(request, reply, "templates/form", {
      title: "Nuevo template",
      activeNav: "templates",
      template: null,
      error: null,
    });
  });

  app.post<{ Body: TemplateForm }>("/templates", async (request, reply) => {
    try {
      const template = await createTemplate(parseTemplateForm(request.body));
      // Straight into continued editing, not back to the index — matches
      // campaigns' create flow. A brand-new template is usually blank right
      // after this (see the editor's own STARTER_BODY) — bouncing to the
      // index meant an extra "Editar" click before you could even start
      // designing it.
      reply.redirect(`/templates/${template.id}/edit?flash=${encodeURIComponent("Template creado")}`);
    } catch (err) {
      sendPage(request, reply, "templates/form", {
        title: "Nuevo template",
        activeNav: "templates",
        template: request.body,
        error: (err as Error).message,
      });
    }
  });

  app.get<{ Params: { id: string } }>("/templates/:id/edit", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    const template = id === null ? null : await getTemplateById(id);
    if (!template) {
      reply.code(404).send("Template no encontrado");
      return;
    }
    sendPage(request, reply, "templates/form", {
      title: "Editar template",
      activeNav: "templates",
      template,
      error: null,
    });
  });

  app.post<{ Params: { id: string }; Body: TemplateForm }>("/templates/:id", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Template no encontrado");
      return;
    }
    try {
      await updateTemplate(id, parseTemplateForm(request.body));
      reply.redirect(`/templates?flash=${encodeURIComponent("Template actualizado")}`);
    } catch (err) {
      sendPage(request, reply, "templates/form", {
        title: "Editar template",
        activeNav: "templates",
        template: { id, ...request.body },
        error: (err as Error).message,
      });
    }
  });

  // Renders the saved template with sample contact data, exactly like a real
  // send would — so "guardar y ver cómo queda" doesn't need a one-off tool
  // each time. Shows what's SAVED, not unsaved textarea edits.
  app.get<{ Params: { id: string } }>("/templates/:id/preview", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    const template = id === null ? null : await getTemplateById(id);
    if (!template) {
      reply.code(404).send("Template no encontrado");
      return;
    }
    try {
      const campaign: Record<string, string> = {};
      for (const field of extractCampaignFieldNames(template.htmlContent)) {
        campaign[field] = SAMPLE_CAMPAIGN_VALUES[field] ?? `[${field} de ejemplo]`;
      }
      const html = renderTemplate(template.htmlContent, {
        campaign,
        contact: { firstName: "María", lastName: "García", email: "maria@example.com", attributes: {} },
        unsubscribeUrl: "#vista-previa",
      });
      reply.type("text/html").send(wrapPreviewWithDeviceToggle(html));
    } catch (err) {
      reply.code(400).type("text/plain").send(`No se pudo generar la vista previa: ${(err as Error).message}`);
    }
  });

  app.post<{ Params: { id: string } }>("/templates/:id/delete", async (request, reply) => {
    const id = parseIdParam(request.params.id);
    if (id === null) {
      reply.code(404).send("Template no encontrado");
      return;
    }
    try {
      await deleteTemplate(id);
      reply.redirect(`/templates?flash=${encodeURIComponent("Template eliminado")}`);
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
      const template = await getTemplateById(id);
      sendPage(request, reply, "templates/form", {
        title: "Editar template",
        activeNav: "templates",
        template,
        error: "No se puede borrar: todavía hay una o más campañas que usan este template.",
      });
    }
  });
}
