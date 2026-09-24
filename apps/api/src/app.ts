import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { page } from "./pageTemplate.js";
import { fontsRoutes } from "./routes/fonts.js";
import { sesWebhookRoutes } from "./routes/sesWebhook.js";
import { trackingRoutes } from "./routes/tracking.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { webhookRoutes } from "./routes/webhooks.js";

// The SES webhook's auth token lives in the URL itself (SNS can't send custom
// headers — see env.ts's SES_WEBHOOK_TOKEN comment), so Fastify's default
// request logging would otherwise write that secret, in plaintext, to every
// log line for every hit on this route. Redact it before it's ever logged.
export function redactSesToken(url: string): string {
  return url.replace(/^(\/webhooks\/ses\/)[^/?]+/, "$1[redacted]");
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Caddy sits in front of this app in production, so every request
    // otherwise looks like it comes from Caddy's own container IP — without
    // this, per-IP rate limiting would treat the entire internet as one
    // client. Caddy's reverse_proxy sets X-Forwarded-For by default.
    trustProxy: true,
    logger:
      process.env.NODE_ENV !== "test"
        ? {
            serializers: {
              req(request) {
                return {
                  method: request.method,
                  url: redactSesToken(request.url),
                  hostname: request.hostname,
                  remoteAddress: request.ip,
                  remotePort: request.socket?.remotePort,
                };
              },
            },
          }
        : false,
  });

  // Defense in depth for the uploads/fonts routes: without this, some older
  // browsers will "sniff" a response's real content type from its bytes
  // instead of trusting the declared Content-Type, which matters if an
  // uploaded file's declared MIME type (checked at upload time, not
  // re-verified from the file's actual bytes) ever turned out to be wrong.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  // Applies to every route by default (global: true) — this app is entirely
  // public-facing with no accounts to key off, so a leaked tracking/click
  // token or an uploads/fonts URL could otherwise be replayed without limit.
  // The two webhook routes opt back out below: they're machine-to-machine
  // (WooCommerce, AWS SNS), already gated by signature verification, and a
  // real burst of legitimate deliveries shouldn't get throttled.
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });

  // WooCommerce signs the raw request body — the default JSON parser discards
  // it, so we capture the raw string alongside the parsed body before it's lost.
  function parseAsJson(request: unknown, body: unknown, done: (err: Error | null, result?: unknown) => void) {
    (request as { rawBody: string }).rawBody = body as string;
    if (!body) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      // Malformed input (a bot sending PHP-exploit payloads at random paths
      // has been observed doing this) is the client's fault, not a server
      // bug — Fastify defaults an error with no .statusCode to 500, which
      // reads as "something crashed" in the logs for what's actually a
      // correctly-rejected bad request.
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  }
  app.addContentTypeParser("application/json", { parseAs: "string" }, parseAsJson);
  // A real WooCommerce webhook delivery has shown up with no Content-Type
  // header at all (observed in production) — Fastify has no built-in
  // fallback for that and rejects it with a 415 before this app's own
  // signature check ever runs, silently dropping a real order/customer
  // sync. Every POST body this app ever receives is JSON regardless of
  // what header (if any) announced it — apps/api has no multipart/form
  // routes — so anything not already matched above is parsed the same way.
  app.addContentTypeParser("*", { parseAs: "string" }, parseAsJson);

  await app.register(webhookRoutes);
  await app.register(sesWebhookRoutes);
  await app.register(trackingRoutes);
  await app.register(unsubscribeRoutes);
  await app.register(uploadsRoutes);
  await app.register(fontsRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  // The only routes here that a person's own browser ever hits directly are
  // the unsubscribe pages; everything else (webhooks, tracking pixel) is
  // machine-to-machine and doesn't care what a 404 body looks like. Still
  // worth a real page instead of Fastify's bare `{"message":"Route ... not
  // found"}` JSON, for the person who follows a stale or mistyped link.
  app.setNotFoundHandler((_request, reply) => {
    reply
      .code(404)
      .type("text/html")
      .send(page("Página no encontrada", "<p>El link que seguiste no existe o ya no está disponible.</p>"));
  });

  return app;
}
