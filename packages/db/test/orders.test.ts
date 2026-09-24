import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { upsertOrderFromWoo } from "../src/repositories/orders.js";
import { contacts, orders } from "../src/schema.js";

const raceEmail = "audit-test-order-race@example.com";
const orderIds = [900001, 900002, 900003];

afterEach(async () => {
  await db.delete(orders).where(inArray(orders.wooOrderId, orderIds));
  await db.delete(contacts).where(eq(contacts.email, raceEmail));
});

function makeOrderInput(overrides: Partial<Parameters<typeof upsertOrderFromWoo>[0]>) {
  return {
    wooOrderId: 900001,
    wooCustomerId: null,
    billingEmail: null,
    status: "processing",
    total: "10.00",
    currency: "EUR",
    createdAt: new Date(),
    completedAt: null,
    shippingMethod: null,
    items: [],
    ...overrides,
  };
}

describe("upsertOrderFromWoo", () => {
  it("stores an order with a null contactId when there's no email and no wooCustomerId (guest checkout, inconsistent data)", async () => {
    const order = await upsertOrderFromWoo(makeOrderInput({ wooOrderId: 900001 }));
    expect(order.contactId).toBeNull();
  });

  it("does not crash when two orders for the same brand-new email arrive concurrently, and both resolve to the same contact", async () => {
    const [orderA, orderB] = await Promise.all([
      upsertOrderFromWoo(makeOrderInput({ wooOrderId: 900002, billingEmail: raceEmail })),
      upsertOrderFromWoo(makeOrderInput({ wooOrderId: 900003, billingEmail: raceEmail })),
    ]);

    expect(orderA.contactId).not.toBeNull();
    expect(orderA.contactId).toBe(orderB.contactId);
  });

  it("stores the shipping method and updates it on a later sync", async () => {
    const order = await upsertOrderFromWoo(makeOrderInput({ wooOrderId: 900001, shippingMethod: "flat_rate" }));
    expect(order.shippingMethod).toBe("flat_rate");

    const updated = await upsertOrderFromWoo(
      makeOrderInput({ wooOrderId: 900001, shippingMethod: "local_pickup" }),
    );
    expect(updated.shippingMethod).toBe("local_pickup");
  });

  it("keeps an order's existing contact link when a later sync's payload resolves to no contact (blank billing/customer id)", async () => {
    const linked = await upsertOrderFromWoo(makeOrderInput({ wooOrderId: 900001, billingEmail: raceEmail }));
    expect(linked.contactId).not.toBeNull();

    // Same order re-synced with blank billing info and no wooCustomerId —
    // e.g. a GDPR/RGPD erasure blanking an old order's billing fields, or a
    // partial payload — must not unlink it from the contact already found.
    const resynced = await upsertOrderFromWoo(
      makeOrderInput({ wooOrderId: 900001, billingEmail: null, wooCustomerId: null, status: "completed" }),
    );

    expect(resynced.contactId).toBe(linked.contactId);
    expect(resynced.status).toBe("completed");
  });
});
