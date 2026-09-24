import { and, count, eq } from "drizzle-orm";
import { db } from "../client.js";
import { contactLists, contacts, lists } from "../schema.js";

export interface ListInput {
  name: string;
  description?: string | null;
  optin?: "single" | "double";
}

export async function getAllLists() {
  return db.select().from(lists).orderBy(lists.name);
}

export async function getAllListsWithSubscriberCounts() {
  return db
    .select({
      id: lists.id,
      name: lists.name,
      description: lists.description,
      optin: lists.optin,
      createdAt: lists.createdAt,
      subscriberCount: count(contactLists.contactId),
    })
    .from(lists)
    // The status filter has to live in the join condition, not a WHERE
    // clause — a WHERE would turn this into an effective inner join and drop
    // any list whose only members are unsubscribed (it would just disappear
    // from the page instead of showing "0"). Without this filter at all, the
    // count included unsubscribed/pending members too, showing a bigger
    // number here than getSubscribedContactIdsForList would ever actually
    // send a campaign to.
    .leftJoin(
      contactLists,
      and(eq(contactLists.listId, lists.id), eq(contactLists.status, "subscribed")),
    )
    .groupBy(lists.id)
    .orderBy(lists.name);
}

export async function getListById(id: number) {
  const [row] = await db.select().from(lists).where(eq(lists.id, id)).limit(1);
  return row ?? null;
}

export interface ListContactRow {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
}

/** For "who's actually on this list" — a real question with no answer
 * anywhere in the UI before this (only the subscriber count existed).
 * Includes every membership status, not just "subscribed" — an admin
 * looking at "who's here" needs to see an unsubscribed/pending member too,
 * unlike the subscriber-count/campaign-audience paths, which deliberately
 * only ever count "subscribed". */
export async function getContactsForList(
  listId: number,
  { limit, offset }: { limit: number; offset: number },
): Promise<{ contacts: ListContactRow[]; total: number }> {
  const where = eq(contactLists.listId, listId);
  const [rows, [{ count: total }]] = await Promise.all([
    db
      .select({
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        status: contacts.status,
      })
      .from(contactLists)
      .innerJoin(contacts, eq(contacts.id, contactLists.contactId))
      .where(where)
      .orderBy(contacts.id)
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(contactLists).where(where),
  ]);
  return { contacts: rows, total };
}

export async function createList(input: ListInput) {
  const [row] = await db
    .insert(lists)
    .values({ name: input.name, description: input.description ?? null, optin: input.optin ?? "single" })
    .returning();
  return row;
}

export async function updateList(id: number, input: ListInput) {
  const [row] = await db
    .update(lists)
    .set({ name: input.name, description: input.description ?? null, optin: input.optin ?? "single" })
    .where(eq(lists.id, id))
    .returning();
  return row ?? null;
}

export async function deleteList(id: number) {
  await db.delete(lists).where(eq(lists.id, id));
}
