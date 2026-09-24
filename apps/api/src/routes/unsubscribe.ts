import type { FastifyInstance } from "fastify";
import { getContactByTrackingToken } from "@carnival/db";
import { resubscribeByToken, unsubscribeByToken } from "../handleUnsubscribe.js";
import { page } from "../pageTemplate.js";

function invalidLinkPage(): string {
  return page("Este link ya no es válido", "<p>Puede que ya te hayas dado de baja o que el link haya expirado.</p>");
}

// Its own rate-limit bucket, separate from the app-wide default (registered
// global in app.ts) that the tracking pixel/click-redirect routes share —
// without this, a burst of pixel opens or link-prefetching from one IP
// (routine for corporate mail-security gateways scanning an email for many
// employees behind the same NAT) could exhaust the shared budget and make a
// real person's unsubscribe request get throttled, right when they're trying
// to exercise a right the law requires honoring promptly.
const UNSUBSCRIBE_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };

export async function unsubscribeRoutes(app: FastifyInstance) {
  // RFC 8058 one-click target for the List-Unsubscribe-Post header — mail
  // clients POST here automatically. Must act with no page and no further
  // confirmation; never wire this action to GET/HEAD (a link-prefetcher hitting
  // GET must not unsubscribe someone — see Mautic issue #14916).
  app.post<{ Params: { token: string } }>(
    "/unsubscribe/:token",
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request, reply) => {
      await unsubscribeByToken(request.params.token);
      return reply.code(200).send({ status: "ok" });
    },
  );

  // Manual click from the email body. Deliberately does NOT act on this GET —
  // corporate mail-security gateways (Proofpoint, Microsoft Safe Links, etc.)
  // routinely pre-fetch every link in an email before a human ever opens it,
  // so a GET that unsubscribes someone fires for real people who never
  // clicked anything. This only looks up the token (read-only) and renders a
  // confirmation button; the actual unsubscribe happens on the POST below,
  // which only a real click (or an already-suspicious automated form
  // submission, a much smaller and differently-shaped risk) can trigger.
  app.get<{ Params: { token: string } }>(
    "/unsubscribe/:token",
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request, reply) => {
      const contact = await getContactByTrackingToken(request.params.token);
      const html = contact
        ? page(
            "¿Confirmás que querés darte de baja?",
            `<form method="post" action="/unsubscribe/${encodeURIComponent(request.params.token)}/confirm">
             <button type="submit">Sí, darme de baja</button>
           </form>`,
          )
        : invalidLinkPage();
      reply.header("content-type", "text/html; charset=utf-8").send(html);
    },
  );

  app.post<{ Params: { token: string } }>(
    "/unsubscribe/:token/confirm",
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request, reply) => {
      const result = await unsubscribeByToken(request.params.token);
      const html = result.found
        ? page(
            "Diste de baja tu suscripción",
            `<p>Ya no vas a recibir más emails nuestros.</p>
           <p>¿Fue un error? <a href="/unsubscribe/${encodeURIComponent(request.params.token)}/resubscribe">Volver a suscribirte</a>.</p>`,
          )
        : invalidLinkPage();
      reply.header("content-type", "text/html; charset=utf-8").send(html);
    },
  );

  // Same reasoning as the unsubscribe GET above: a prefetched "undo" link
  // must not silently resubscribe someone who deliberately opted out.
  app.get<{ Params: { token: string } }>(
    "/unsubscribe/:token/resubscribe",
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request, reply) => {
      const contact = await getContactByTrackingToken(request.params.token);
      const html = contact
        ? page(
            "¿Volver a suscribirte?",
            `<form method="post" action="/unsubscribe/${encodeURIComponent(request.params.token)}/resubscribe/confirm">
             <button type="submit">Sí, volver a suscribirme</button>
           </form>`,
          )
        : page("Este link ya no es válido", "<p>Puede que el link haya expirado.</p>");
      reply.header("content-type", "text/html; charset=utf-8").send(html);
    },
  );

  app.post<{ Params: { token: string } }>(
    "/unsubscribe/:token/resubscribe/confirm",
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request, reply) => {
      const result = await resubscribeByToken(request.params.token);
      const html = result.found
        ? page("Te volviste a suscribir", "<p>Vas a volver a recibir nuestros emails.</p>")
        : page("Este link ya no es válido", "<p>Puede que el link haya expirado.</p>");
      reply.header("content-type", "text/html; charset=utf-8").send(html);
    },
  );
}
