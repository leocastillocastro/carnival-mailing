import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  // Loopback by default: the admin has no TLS and is meant for a single
  // operator. Set HOST=0.0.0.0 to reach it from the LAN, and only behind a
  // firewall that keeps it off the public internet.
  HOST: z.string().default("127.0.0.1"),
  NODE_ENV: z.string().default("development"),
  // Independent from NODE_ENV on purpose: whether the session cookie gets the
  // Secure flag depends on whether this deployment sits behind TLS, not on
  // whether it's "production" — e.g. a LAN-only deployment served over plain
  // HTTP is still production, but a Secure cookie there is silently dropped
  // by the browser and breaks login.
  // NOT z.coerce.boolean() — Boolean("false") is `true` in JS, so that would
  // coerce the literal string "false" to true and silently ignore this setting.
  SECURE_COOKIES: z
    .string()
    .default("true")
    .transform((value) => value !== "false"),
  // Where uploaded images are actually reachable from — apps/api's public
  // domain (apps/admin itself is deliberately LAN-only, so its own address
  // wouldn't load in an email opened outside the network). apps/api serves
  // the same shared uploads/ directory this app writes into.
  UPLOADS_PUBLIC_URL: z.string().url(),
  // Public WordPress site — used only to browse its existing media library
  // (GET /wp-json/wp/v2/media, no auth) so templates can reuse photos already
  // uploaded there instead of re-uploading. Not the WooCommerce API (that
  // lives in apps/api and needs consumer key/secret); this is just the site.
  WORDPRESS_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);
