import { getCampaignSendByTrackingToken, recordEvent } from "@carnival/db";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

// Smallest valid transparent GIF — served for every open, valid token or not,
// so a scraper/proxy can't use response differences to probe token validity.
const TRANSPARENT_PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

/** A tracking token only proves "you're a real recipient", not "this
 * redirect is safe" — `u` is otherwise fully attacker-controlled, and a
 * token never expires, so anyone who's ever received one real email could
 * otherwise turn this route into an open redirector. Restricting the
 * destination host to the ones this business's own templates actually link
 * to closes that off without needing to know which exact link belongs to
 * which campaign. */
function isTrackableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return env.TRACKING_ALLOWED_REDIRECT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export async function trackingRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/t/o/:token", async (request, reply) => {
    const send = await getCampaignSendByTrackingToken(request.params.token);
    if (send) {
      await recordEvent({ contactId: send.contactId, campaignId: send.campaignId, sendId: send.id, type: "open" });
    }

    reply
      .header("content-type", "image/gif")
      .header("cache-control", "private, no-cache, no-store, must-revalidate")
      .send(TRANSPARENT_PIXEL);
  });

  app.get<{ Params: { token: string }; Querystring: { u?: string } }>(
    "/t/c/:token",
    async (request, reply) => {
      const target = request.query.u;
      if (!target || !isTrackableUrl(target)) {
        return reply.code(400).send({ error: "missing or invalid u" });
      }

      const send = await getCampaignSendByTrackingToken(request.params.token);
      if (!send) {
        // Unlike the pixel/unsubscribe routes, this one can't stay silent about
        // an unknown token: `u` is attacker-controllable and redirecting
        // unconditionally would make this endpoint an open redirector usable by
        // anyone, with no need to ever have seen a real tracking link.
        // campaign_sends rows are never deleted, so "unknown" here only ever
        // means malformed/made-up, not a legitimately expired real token.
        return reply.code(404).send({ error: "unknown token" });
      }

      await recordEvent({
        contactId: send.contactId,
        campaignId: send.campaignId,
        sendId: send.id,
        type: "click",
        url: target,
      });

      return reply.redirect(target, 302);
    },
  );
}
