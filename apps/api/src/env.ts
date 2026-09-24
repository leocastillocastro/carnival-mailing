import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  WC_URL: z.string().url(),
  WC_CONSUMER_KEY: z.string().min(1),
  WC_CONSUMER_SECRET: z.string().min(1),
  WC_WEBHOOK_SECRET: z.string().min(1),
  // SNS can't send custom headers, so this doubles as the endpoint's auth: it's
  // embedded in the subscription URL itself (https://.../webhooks/ses/<token>).
  SES_WEBHOOK_TOKEN: z.string().min(20),
  // Real auth for the webhook body: any message not signed for exactly this
  // topic is rejected, even if its SNS signature is otherwise genuine — an
  // attacker with their own AWS account could otherwise get a validly-signed
  // message for a topic they own and replay its shape here.
  SES_SNS_TOPIC_ARN: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  // Hosts a click-tracking redirect (GET /t/c/:token?u=...) is allowed to send
  // someone to. Without this, `u` would only need to be a well-formed http(s)
  // URL — since a tracking token is trivial to obtain (subscribe once, it
  // never expires), that alone makes the redirect endpoint an open redirector
  // usable to lend this domain's trust to a phishing link. A subdomain of any
  // listed host is allowed too (e.g. "es.wikipedia.org" for "wikipedia.org").
  TRACKING_ALLOWED_REDIRECT_HOSTS: z
    .string()
    .default("example.com,www.google.com,wa.me")
    .transform((value) => value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)),
});

export const env = envSchema.parse(process.env);
