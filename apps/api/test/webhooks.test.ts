import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  upsertContactFromWoo: vi.fn(),
  upsertOrderFromWoo: vi.fn(),
  recordDeliveryOutcome: vi.fn(),
  claimDelivery: vi.fn().mockResolvedValue("claimed"),
}));
vi.mock("@carnival/db", () => db);

const { buildApp } = await import("../src/app.js");

const webhookSecret = process.env.WC_WEBHOOK_SECRET!;

function sign(body: string) {
  return createHmac("sha256", webhookSecret).update(body).digest("base64");
}

async function postWebhook(
  app: FastifyInstance,
  opts: { topic?: string; deliveryId?: string; body: unknown; badSignature?: boolean },
) {
  const payload = JSON.stringify(opts.body);
  return app.inject({
    method: "POST",
    url: "/webhooks/woocommerce",
    headers: {
      "content-type": "application/json",
      ...(opts.topic ? { "x-wc-webhook-topic": opts.topic } : {}),
      ...(opts.deliveryId ? { "x-wc-webhook-delivery-id": opts.deliveryId } : {}),
      "x-wc-webhook-signature": opts.badSignature ? "not-a-real-signature" : sign(payload),
    },
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.claimDelivery.mockResolvedValue("claimed");
});

describe("POST /webhooks/woocommerce", () => {
  // Observed in production: a real WooCommerce delivery arrived with no
  // Content-Type header at all, which Fastify has no built-in fallback for
  // and rejected with a 415 before this route's own signature check ever
  // ran — silently dropping a real order/customer sync, with nothing in
  // the app's own logic ever getting a chance to log or reject it properly.
  it("still parses and processes the body when the request has no Content-Type header", async () => {
    const app = await buildApp();
    const body = { id: 1, email: "x@example.com" };
    const payload = JSON.stringify(body);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/woocommerce",
      headers: {
        "x-wc-webhook-topic": "customer.updated",
        "x-wc-webhook-delivery-id": "d-no-content-type",
        "x-wc-webhook-signature": sign(payload),
      },
      payload,
    });

    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).toBe(200);
    expect(db.upsertContactFromWoo).toHaveBeenCalled();
  });

  it("rejects an invalid signature without touching the database", async () => {
    const app = await buildApp();
    const res = await postWebhook(app, {
      topic: "customer.updated",
      deliveryId: "d1",
      body: { id: 1, email: "x@example.com" },
      badSignature: true,
    });

    expect(res.statusCode).toBe(401);
    expect(db.upsertContactFromWoo).not.toHaveBeenCalled();
    expect(db.recordDeliveryOutcome).not.toHaveBeenCalled();
  });

  it("returns 'duplicate' and skips processing when the delivery was already handled", async () => {
    db.claimDelivery.mockResolvedValue("duplicate");
    const app = await buildApp();

    const res = await postWebhook(app, {
      topic: "order.updated",
      deliveryId: "d2",
      body: { id: 1 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "duplicate" });
    expect(db.upsertOrderFromWoo).not.toHaveBeenCalled();
  });

  it("upserts the contact and records the delivery as processed on a valid customer webhook", async () => {
    const app = await buildApp();
    const customer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-01T10:00:00",
    };

    const res = await postWebhook(app, { topic: "customer.updated", deliveryId: "d3", body: customer });

    expect(res.statusCode).toBe(200);
    expect(db.upsertContactFromWoo).toHaveBeenCalledWith(
      expect.objectContaining({ email: "cliente@example.com", wooCustomerId: 42 }),
    );
    expect(db.recordDeliveryOutcome).toHaveBeenCalledWith("woocommerce", "customer.updated", "d3", expect.anything(), "processed");
  });

  it("skips a customer webhook with no email instead of upserting a blank one, but still marks it processed", async () => {
    const app = await buildApp();
    const customer = {
      id: 43,
      email: "",
      first_name: "Sin",
      last_name: "Email",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-01T10:00:00",
    };

    const res = await postWebhook(app, { topic: "customer.updated", deliveryId: "d4", body: customer });

    expect(res.statusCode).toBe(200);
    expect(db.upsertContactFromWoo).not.toHaveBeenCalled();
    expect(db.recordDeliveryOutcome).toHaveBeenCalledWith("woocommerce", "customer.updated", "d4", expect.anything(), "processed");
  });

  it("returns 500 and records the delivery as failed (not processed) when processing throws, so a WooCommerce retry can reprocess it", async () => {
    db.upsertOrderFromWoo.mockRejectedValue(new Error("db exploded"));
    const app = await buildApp();

    const order = {
      id: 100,
      status: "processing",
      currency: "EUR",
      total: "10.00",
      date_created: "2026-01-01T10:00:00",
      date_completed: null,
      customer_id: 1,
      billing: { email: "cliente@example.com", first_name: "Ana", last_name: "García" },
      line_items: [],
    };

    const res = await postWebhook(app, { topic: "order.updated", deliveryId: "d5", body: order });

    expect(res.statusCode).toBe(500);
    expect(db.recordDeliveryOutcome).toHaveBeenCalledWith("woocommerce", "order.updated", "d5", expect.anything(), "failed");
  });
});
