import type { FastifyInstance } from "fastify";
import { createSession, destroySession, findUserByEmail } from "@carnival/db";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../auth.js";
import { sendPage } from "../render.js";
import { SESSION_COOKIE, sessionCookieOptions } from "../session.js";

interface LoginBody {
  email?: string;
  password?: string;
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/login", async (request, reply) => {
    if (request.sessionUser) {
      reply.redirect("/");
      return;
    }
    sendPage(request, reply, "login", { title: "Iniciar sesión", error: null });
  });

  app.post<{ Body: LoginBody }>(
    "/login",
    // This is the only account guarding the whole contact database, so brute
    // force needs to be shut down at the door, not just have wrong attempts logged.
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = email ? await findUserByEmail(email) : null;
      // Always run the scrypt derivation, even for an email that doesn't
      // exist — otherwise that case returns near-instantly while a wrong
      // password for a real account pays the real cost, letting an attacker
      // tell them apart by response time despite the identical error message.
      const valid = await verifyPassword(password ?? "", user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user || !valid) {
        sendPage(request, reply, "login", { title: "Iniciar sesión", error: "Email o contraseña incorrectos" });
        return;
      }
      const { token, expiresAt } = await createSession(user.id);
      reply.setCookie(SESSION_COOKIE, token, { ...sessionCookieOptions, expires: expiresAt });
      reply.redirect("/");
    },
  );

  app.post("/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.redirect("/login");
  });
}
