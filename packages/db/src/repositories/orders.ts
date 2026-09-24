import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { normalizeEmail } from "../normalizeEmail.js";
import { contacts, orderItems, orders } from "../schema.js";
import { findContactByEmail, findContactByWooCustomerId } from "./contacts.js";

export interface OrderItemInput {
  wooProductId: number | null;
  productName: string;
  sku: string | null;
  category: string | null;
  quantity: number;
  price: string;
}

export interface OrderUpsertInput {
  wooOrderId: number;
  wooCustomerId: number | null;
  billingEmail: string | null;
  status: string;
  total: string | null;
  currency: string | null;
  createdAt: Date;
  completedAt: Date | null;
  shippingMethod: string | null;
  items: OrderItemInput[];
}

async function resolveContactId(input: OrderUpsertInput): Promise<number | null> {
  if (input.wooCustomerId) {
    const byWooId = await findContactByWooCustomerId(input.wooCustomerId);
    if (byWooId) return byWooId.id;
  }
  if (input.billingEmail) {
    const email = normalizeEmail(input.billingEmail);
    const byEmail = await findContactByEmail(email);
    if (byEmail) return byEmail.id;
    // Two concurrent orders for the same new email can both reach here — the
    // loser's insert is a no-op (conflict on the email unique index) instead of
    // throwing, and it just re-fetches the winner's row.
    const [created] = await db
      .insert(contacts)
      .values({
        email,
        wooCustomerId: input.wooCustomerId || null,
      })
      .onConflictDoNothing({ target: contacts.email })
      .returning();
    if (created) return created.id;
    const existing = await findContactByEmail(email);
    return existing?.id ?? null;
  }
  return null;
}

export async function upsertOrderFromWoo(input: OrderUpsertInput) {
  const contactId = await resolveContactId(input);

  return db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        wooOrderId: input.wooOrderId,
        contactId,
        status: input.status,
        total: input.total,
        currency: input.currency,
        createdAt: input.createdAt,
        completedAt: input.completedAt,
        shippingMethod: input.shippingMethod,
      })
      .onConflictDoUpdate({
        target: orders.wooOrderId,
        set: {
          // On an UPDATE (not a fresh insert), a contactId that resolved to
          // null this time — e.g. a re-sync whose payload has blank/missing
          // billing info, which can legitimately happen (a GDPR/RGPD data
          // erasure blanking an old order's billing fields, a partial
          // payload) — must not silently overwrite a link a previous sync
          // already established. Keep the existing value in that case
          // instead of unlinking the order from its contact.
          contactId: contactId === null ? sql`${orders.contactId}` : contactId,
          status: input.status,
          total: input.total,
          currency: input.currency,
          completedAt: input.completedAt,
          shippingMethod: input.shippingMethod,
          updatedAt: new Date(),
        },
      })
      .returning();

    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    if (input.items.length > 0) {
      await tx.insert(orderItems).values(
        input.items.map((item) => ({
          orderId: order.id,
          wooProductId: item.wooProductId,
          productName: item.productName,
          sku: item.sku,
          category: item.category,
          quantity: item.quantity,
          price: item.price,
        })),
      );
    }

    return order;
  });
}
