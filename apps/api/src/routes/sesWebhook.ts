import { timingSafeEqual } from "node:crypto";
import { isTrustedSnsHost, verifySnsSignature, type SnsSignedEnvelope } from "@carnival/mailer";
import { claimDelivery, recordDeliveryOutcome } from "@carnival/db";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { env } from "../env.js";
import { handleSesNotification } from "../handleSesNotification.js";

type SnsEnvelope = SnsSignedEnvelope;

// AWS SNS never sends custom headers, so a shared secret has to live in the URL
// (or basic-auth userinfo, which SNS also just folds into the URL) — this at
// least keeps the comparison timing-safe. This alone isn't authentication for
// the message body (see verifySnsSignature below) — it just keeps random
// internet noise from reaching the expensive signature-verification step.
function isValidToken(token: string): boolean {
  const expected = Buffer.from(env.SES_WEBHOOK_TOKEN);
  const received = Buffer.from(token);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

async function confirmSubscription(subscribeUrl: string | undefined, log: FastifyBaseLogger) {
  if (!subscribeUrl) {
    throw new Error("SubscriptionConfirmation message is missing a SubscribeURL");
  }
  if (!isTrustedSnsHost(subscribeUrl)) {
    // Refuse to blindly GET an attacker-supplied URL (SSRF) — a real SNS
    // confirmation always comes from a sns.<region>.amazonaws.com host.
    // subscribeUrl itself may not even be a parseable URL (not just an
    // untrusted host) — isTrustedSnsHost already swallows that internally
    // and returns false either way, but re-parsing it here to build this
    // message would throw the same way, replacing this descriptive error
    // with a bare `TypeError: Invalid URL` and losing the actual reason.
    let hostname = "(not a valid URL)";
    try {
      hostname = new URL(subscribeUrl).hostname;
    } catch {
      // Already logged as the message's fallback text above.
    }
    throw new Error(`refusing to confirm subscription at untrusted host: ${hostname}`);
  }
  const res = await fetch(subscribeUrl);
  if (!res.ok) {
    throw new Error(`SNS subscription confirmation request failed: ${res.status}`);
  }
  log.info("confirmed SNS subscription for SES bounce/complaint notifications");
}

export async function sesWebhookRoutes(app: FastifyInstance) {
  // SNS posts a JSON body but declares it as text/plain — scoped to this
  // plugin only, so it doesn't affect the WooCommerce webhook's JSON parsing.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (request, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Machine-to-machine (AWS SNS), already gated by the URL token plus SNS
  // signature verification — exempt from the app-wide IP rate limit so a
  // real burst of bounce/complaint notifications isn't dropped.
  app.post<{ Params: { token: string } }>(
    "/webhooks/ses/:token",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!isValidToken(request.params.token)) {
        return reply.code(401).send({ error: "invalid token" });
      }

      const envelope = request.body as SnsEnvelope;
      const eventType = envelope.Type ?? "unknown";
      const messageId = envelope.MessageId ?? null;

      // The URL token only filters out random internet noise — this is the
      // real proof the message came from *our* SNS topic and wasn't
      // tampered with. Checking TopicArn matters even with a valid
      // signature: anyone with their own AWS account can get SNS to
      // genuinely sign a message for a topic they own, so signature
      // validity alone doesn't prove it's ours.
      if (envelope.TopicArn !== env.SES_SNS_TOPIC_ARN || !(await verifySnsSignature(envelope))) {
        return reply.code(401).send({ error: "invalid signature" });
      }

      if ((await claimDelivery("ses", messageId, eventType, request.body)) === "duplicate") {
        return reply.code(200).send({ status: "duplicate" });
      }

      try {
        if (envelope.Type === "SubscriptionConfirmation") {
          await confirmSubscription(envelope.SubscribeURL, request.log);
        } else if (envelope.Type === "Notification") {
          await handleSesNotification(envelope.Message);
        } else {
          request.log.warn({ type: envelope.Type }, "unhandled SNS message type");
        }
      } catch (err) {
        await recordDeliveryOutcome("ses", eventType, messageId, request.body, "failed");
        request.log.error(err, "failed to process SES/SNS webhook");
        return reply.code(500).send({ error: "processing failed" });
      }

      await recordDeliveryOutcome("ses", eventType, messageId, request.body, "processed");
      return reply.code(200).send({ status: "ok" });
    },
  );
}
