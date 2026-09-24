import { env } from "./env.js";

export const SESSION_COOKIE = "carnival_admin_session";

export const sessionCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.SECURE_COOKIES,
};
