import { upsertContactFromWoo, upsertOrderFromWoo, claimDelivery, recordDeliveryOutcome } from "@carnival/db";
import {
  mapWooCustomerToContact,
  mapWooOrderToOrder,
  verifyWooSignature,
  type WooCustomer,
  type WooOrder,
} from "@carnival/woocommerce";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

export async function webhookRoutes(app: FastifyInstance) {
  // Machine-to-machine (WooCommerce's own servers), already gated by
  // signature verification — exempt from the app-wide IP rate limit so a
  // legitimate burst of deliveries (e.g. a bulk edit on their end) isn't
  // dropped.
  app.post("/webhooks/woocommerce", { config: { rateLimit: false } }, async (request, reply) => {
    const rawBody = (request as { rawBody?: string }).rawBody ?? "";
    const signature = request.headers["x-wc-webhook-signature"] as string | undefined;

    if (!verifyWooSignature(rawBody, signature, env.WC_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const topic = request.headers["x-wc-webhook-topic"] as string | undefined;
    const deliveryId = (request.headers["x-wc-webhook-delivery-id"] as string | undefined) ?? null;
    const eventType = topic ?? "unknown";

    if ((await claimDelivery("woocommerce", deliveryId, eventType, request.body)) === "duplicate") {
      // Already claimed/processed this delivery id — WooCommerce retried it.
      return reply.code(200).send({ status: "duplicate" });
    }

    const body = request.body as Record<string, unknown>;

    try {
      switch (topic) {
        case "customer.created":
        case "customer.updated": {
          const contact = mapWooCustomerToContact(body as unknown as WooCustomer);
          if (!contact.email) {
            request.log.warn({ topic }, "woocommerce customer webhook has no email, skipping");
            break;
          }
          await upsertContactFromWoo(contact);
          break;
        }
        case "order.created":
        case "order.updated": {
          const order = mapWooOrderToOrder(body as unknown as WooOrder);
          await upsertOrderFromWoo(order);
          break;
        }
        default:
          request.log.warn({ topic }, "unhandled woocommerce webhook topic");
      }
    } catch (err) {
      // Record as failed (not processed) so a WooCommerce retry with the same
      // delivery id gets reprocessed instead of silently swallowed as a duplicate.
      await recordDeliveryOutcome("woocommerce", eventType, deliveryId, request.body, "failed");
      request.log.error(err, "failed to process woocommerce webhook");
      return reply.code(500).send({ error: "processing failed" });
    }

    await recordDeliveryOutcome("woocommerce", eventType, deliveryId, request.body, "processed");
    return reply.code(200).send({ status: "ok" });
  });
}
