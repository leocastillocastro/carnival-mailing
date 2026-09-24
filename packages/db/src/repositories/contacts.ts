import { and, count, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { normalizeEmail } from "../normalizeEmail.js";
import { contacts } from "../schema.js";

/** Real, sendable audience size — same "not a staff/business account" filter
 * segment resolution always applies (see @carnival/segments' compileSegmentWhere),
 * inlined here rather than imported: packages/segments depends on this
 * package, not the other way around. Kept in sync by intent, not by a shared
 * import — there's only the one other place (`attributes.internal`) this
 * check needs to exist. */
export async function getSubscribedContactCount(): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(contacts)
    .where(and(eq(contacts.status, "subscribed"), sql`${contacts.attributes} ->> 'internal' IS DISTINCT FROM 'true'`));
  return row?.count ?? 0;
}

export interface ContactUpsertInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  wooCustomerId: number;
  // Merged into the existing attributes on conflict (via jsonb `||`), not
  // replaced — a webhook payload with no billing city, say, must not erase a
  // city we already learned from an earlier sync.
  attributes?: Record<string, unknown>;
}

/** Conflict resolves on email, not wooCustomerId: email is the identity the rest of
 * the system keys off (suppressions, sends), and WooCommerce customers can end up
 * pointing at an email that's already in contacts (merged/duplicate accounts) —
 * resolving on wooCustomerId alone would hit the email unique index instead and
 * throw. If a *different* email already legitimately owns this wooCustomerId, this
 * still throws on the wooCustomerId unique index, which is a real data conflict
 * that needs a human, not something to paper over here. */
export async function upsertContactFromWoo(input: ContactUpsertInput) {
  if (!input.email) {
    throw new Error("upsertContactFromWoo: email is required");
  }
  const attributes = input.attributes ?? {};
  const [row] = await db
    .insert(contacts)
    .values({
      email: normalizeEmail(input.email),
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      wooCustomerId: input.wooCustomerId,
      attributes,
    })
    .onConflictDoUpdate({
      target: contacts.email,
      set: {
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        wooCustomerId: input.wooCustomerId,
        attributes: sql`${contacts.attributes} || ${JSON.stringify(attributes)}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

// Powers the segment builder's dropdown for attribute values (e.g. every
// distinct city we know about) instead of making the user free-type a value
// that has to match a stored string exactly.
export async function getDistinctAttributeValues(key: string): Promise<string[]> {
  const valueExpr = sql<string>`${contacts.attributes} ->> ${key}`;
  const rows = await db
    .selectDistinct({ value: valueExpr })
    .from(contacts)
    .where(sql`${valueExpr} is not null`)
    // Order by ordinal position, not by re-emitting the expression — Postgres
    // requires a SELECT DISTINCT's ORDER BY to match a select-list item
    // exactly, and a second `${key}`-interpolated copy of the same
    // expression binds to a different query parameter (a syntactically
    // different, unmatched expression as far as that rule is concerned).
    .orderBy(sql`1`);
  return rows.map((r) => r.value);
}

export async function findContactByWooCustomerId(wooCustomerId: number) {
  const [row] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.wooCustomerId, wooCustomerId))
    .limit(1);
  return row ?? null;
}

export async function findContactByEmail(email: string) {
  const [row] = await db.select().from(contacts).where(eq(contacts.email, normalizeEmail(email))).limit(1);
  return row ?? null;
}

export async function markContactStatus(contactId: number, status: "bounced" | "complained" | "unsubscribed") {
  await db.update(contacts).set({ status, updatedAt: new Date() }).where(eq(contacts.id, contactId));
}

export async function unsubscribeContact(contactId: number) {
  await db
    .update(contacts)
    .set({ status: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

export async function resubscribeContact(contactId: number) {
  await db
    .update(contacts)
    .set({ status: "subscribed", unsubscribedAt: null, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}
