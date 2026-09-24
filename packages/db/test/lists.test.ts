import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { getSubscribedContactIdsForList } from "../src/repositories/campaigns.js";
import { getAllListsWithSubscriberCounts, getContactsForList } from "../src/repositories/lists.js";
import { contactLists, contacts, lists } from "../src/schema.js";

const listName = "audit-test-list";
const emails = ["audit-test-subscribed@example.com", "audit-test-unsubscribed@example.com"];

afterEach(async () => {
  const rows = await db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.email, emails));
  if (rows.length > 0) await db.delete(contacts).where(inArray(contacts.id, rows.map((r) => r.id)));
  await db.delete(lists).where(eq(lists.name, listName));
});

describe("getAllListsWithSubscriberCounts", () => {
  it("only counts members whose contact_lists status is 'subscribed'", async () => {
    const [list] = await db.insert(lists).values({ name: listName }).returning();
    const [subscribed, unsubscribed] = await db
      .insert(contacts)
      .values(emails.map((email) => ({ email })))
      .returning();

    await db.insert(contactLists).values([
      { contactId: subscribed.id, listId: list.id, status: "subscribed" },
      { contactId: unsubscribed.id, listId: list.id, status: "unsubscribed" },
    ]);

    const result = await getAllListsWithSubscriberCounts();
    const row = result.find((r) => r.id === list.id);

    expect(row?.subscriberCount).toBe(1);
  });

  it("still shows a list with 0 subscribed members, not just members with any status", async () => {
    const [list] = await db.insert(lists).values({ name: listName }).returning();
    const [contact] = await db.insert(contacts).values({ email: emails[0] }).returning();
    await db.insert(contactLists).values({ contactId: contact.id, listId: list.id, status: "unsubscribed" });

    const result = await getAllListsWithSubscriberCounts();
    const row = result.find((r) => r.id === list.id);

    expect(row?.subscriberCount).toBe(0);
  });
});

describe("getSubscribedContactIdsForList", () => {
  // A list-targeted campaign goes through this function for its whole
  // audience — segment-targeted campaigns already excluded internal/staff
  // accounts (compileSegmentWhere), but this path didn't, so a campaign
  // sent to "everyone on this list" would include them regardless.
  it("excludes a subscribed member tagged attributes.internal = 'true'", async () => {
    const [list] = await db.insert(lists).values({ name: listName }).returning();
    const [real, internal] = await db
      .insert(contacts)
      .values([{ email: emails[0] }, { email: emails[1], attributes: { internal: "true" } }])
      .returning();
    await db.insert(contactLists).values([
      { contactId: real.id, listId: list.id, status: "subscribed" },
      { contactId: internal.id, listId: list.id, status: "subscribed" },
    ]);

    const result = await getSubscribedContactIdsForList(list.id);

    expect(result).toEqual([real.id]);
  });
});

describe("getContactsForList", () => {
  it("includes every membership status, not just subscribed — unlike the campaign-audience path", async () => {
    const [list] = await db.insert(lists).values({ name: listName }).returning();
    const [subscribed, unsubscribed] = await db
      .insert(contacts)
      .values(emails.map((email) => ({ email })))
      .returning();
    await db.insert(contactLists).values([
      { contactId: subscribed.id, listId: list.id, status: "subscribed" },
      { contactId: unsubscribed.id, listId: list.id, status: "unsubscribed" },
    ]);

    const { contacts: rows, total } = await getContactsForList(list.id, { limit: 50, offset: 0 });

    expect(total).toBe(2);
    expect(rows.map((r) => r.email).sort()).toEqual([...emails].sort());
  });

  it("paginates with limit/offset", async () => {
    const [list] = await db.insert(lists).values({ name: listName }).returning();
    const inserted = await db
      .insert(contacts)
      .values(emails.map((email) => ({ email })))
      .returning();
    await db
      .insert(contactLists)
      .values(inserted.map((c) => ({ contactId: c.id, listId: list.id, status: "subscribed" as const })));

    const { contacts: firstPage, total } = await getContactsForList(list.id, { limit: 1, offset: 0 });
    const { contacts: secondPage } = await getContactsForList(list.id, { limit: 1, offset: 1 });

    expect(total).toBe(2);
    expect(firstPage).toHaveLength(1);
    expect(secondPage).toHaveLength(1);
    expect(firstPage[0].id).not.toBe(secondPage[0].id);
  });
});
