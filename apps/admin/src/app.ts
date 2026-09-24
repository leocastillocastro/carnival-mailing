import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import { getSessionUser } from "@carnival/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { authRoutes } from "./routes/auth.js";
import { campaignsRoutes } from "./routes/campaigns.js";
import { homeRoutes } from "./routes/home.js";
import { listsRoutes } from "./routes/lists.js";
import { segmentsRoutes } from "./routes/segments.js";
import { fontsRoutes } from "./routes/fonts.js";
import { SESSION_COOKIE } from "./session.js";
import { templatesRoutes } from "./routes/templates.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { sendPage } from "./render.js";

declare module "fastify" {
  interface FastifyRequest {
    sessionUser: { userId: number; email: string } | null;
  }
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.sessionUser) {
    reply.redirect("/login");
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Defense in depth for uploaded images: without this, some older browsers
  // will "sniff" a response's real content type from its bytes instead of
  // trusting the declared Content-Type, which matters if an uploaded file's
  // declared MIME type (checked at upload time, not re-verified from the
  // file's actual bytes) ever turned out to be wrong.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart);
  // global: false — only routes that opt in via `config.rateLimit` are limited
  // (just POST /login today), so normal admin navigation is never throttled.
  await app.register(fastifyRateLimit, { global: false });

  app.decorateRequest("sessionUser", null);
  app.addHook("onRequest", async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.sessionUser = token ? await getSessionUser(token) : null;
  });

  await app.register(authRoutes);
  // Public like apps/api's copy (see routes/fonts.ts) — the login page's own
  // @font-face rule needs it before a session exists, so it can't sit behind
  // requireAuth without breaking the login page's headline font.
  await app.register(fontsRoutes);

  await app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", requireAuth);
    await protectedApp.register(homeRoutes);
    await protectedApp.register(listsRoutes);
    await protectedApp.register(templatesRoutes);
    await protectedApp.register(uploadsRoutes);
    await protectedApp.register(segmentsRoutes);
    await protectedApp.register(campaignsRoutes);
  });

  app.get("/health", async () => ({ status: "ok" }));

  // request.sessionUser is set by the onRequest hook above, which runs even
  // for a request that ends up here — so a logged-in admin still sees the
  // normal nav/logout header, not a bare unstyled page.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404);
    sendPage(request, reply, "404", { title: "Página no encontrada" });
  });

  return app;
}
