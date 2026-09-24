// Integration tests against a real Postgres — need
// `docker compose -f infra/docker-compose.yml up -d` running locally.
import { eq, inArray, like } from "drizzle-orm";
import { db, schema } from "@carnival/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countContactsMatchingRule, resolveSegmentContactIds, resolveSegmentContactsPage } from "../src/resolve.js";
import type { RuleGroup } from "../src/types.js";

const { contacts, lists, contactLists, orders, orderItems, events, campaigns, segments } = schema;

const emailDomain = "@segments-resolve-test.example";
const listName = "segments-test:list";
const campaignName = "segments-test:campaign";

const ids: {
  vip: number;
  standardOld: number;
  unsub: number;
  noOrders: number;
  oldSignup: number;
  internal: number;
  listId: number;
  campaignId: number;
} = {} as never;

async function cleanup() {
  const testContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(like(contacts.email, `%${emailDomain}`));
  const contactIds = testContacts.map((c) => c.id);

  if (contactIds.length > 0) {
    await db.delete(events).where(inArray(events.contactId, contactIds));
    const testOrders = await db.select({ id: orders.id }).from(orders).where(inArray(orders.contactId, contactIds));
    const orderIds = testOrders.map((o) => o.id);
    if (orderIds.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(contactLists).where(inArray(contactLists.contactId, contactIds));
  }
  await db.delete(segments).where(like(segments.name, "segments-test:%"));
  await db.delete(campaigns).where(eq(campaigns.name, campaignName));
  await db.delete(contacts).where(like(contacts.email, `%${emailDomain}`));
  await db.delete(lists).where(eq(lists.name, listName));
}

async function createSegment(name: string, rule: RuleGroup) {
  const [row] = await db
    .insert(segments)
    .values({ name: `segments-test:${name}`, definition: rule })
    .returning();
  return row.id;
}

beforeAll(async () => {
  await cleanup();

  const [vip, standardOld, unsub, noOrders, oldSignup, internal] = await db
    .insert(contacts)
    .values([
      { email: `vip${emailDomain}`, status: "subscribed", attributes: { tier: "vip", promo: "ahorro50%" } },
      { email: `standard-old${emailDomain}`, status: "subscribed", attributes: { tier: "standard", promo: "ahorro50X" } },
      { email: `unsub${emailDomain}`, status: "unsubscribed", attributes: {} },
      { email: `no-orders${emailDomain}`, status: "subscribed", attributes: {} },
      {
        email: `old-signup${emailDomain}`,
        status: "subscribed",
        attributes: {},
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      },
      // Same shape as vip (subscribed, would otherwise match plenty of real
      // segments) except tagged as a staff/business account — must never
      // resolve into any segment, no matter what it matches on.
      { email: `internal${emailDomain}`, status: "subscribed", attributes: { internal: "true" } },
    ])
    .returning();
  ids.vip = vip.id;
  ids.standardOld = standardOld.id;
  ids.unsub = unsub.id;
  ids.noOrders = noOrders.id;
  ids.oldSignup = oldSignup.id;
  ids.internal = internal.id;

  const [list] = await db.insert(lists).values({ name: listName }).returning();
  ids.listId = list.id;
  await db.insert(contactLists).values([
    { contactId: ids.vip, listId: ids.listId, status: "subscribed" },
    { contactId: ids.noOrders, listId: ids.listId, status: "subscribed" },
    { contactId: ids.unsub, listId: ids.listId, status: "unsubscribed" },
  ]);

  const [recentOrder] = await db
    .insert(orders)
    .values({
      wooOrderId: 800001,
      contactId: ids.vip,
      status: "completed",
      total: "42.00",
      currency: "EUR",
      createdAt: new Date(),
      shippingMethod: "flat_rate",
    })
    .returning();
  await db.insert(orderItems).values({
    orderId: recentOrder.id,
    productName: "Solomillo",
    sku: "CARNE-1",
    category: "carne",
    quantity: 1,
    price: "42.00",
  });

  const [oldOrder] = await db
    .insert(orders)
    .values({
      wooOrderId: 800002,
      contactId: ids.standardOld,
      status: "completed",
      total: "20.00",
      currency: "EUR",
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    })
    .returning();
  await db.insert(orderItems).values({
    orderId: oldOrder.id,
    productName: "Pechuga de pollo",
    sku: "POLLO-1",
    category: "pollo",
    quantity: 1,
    price: "20.00",
  });

  const [campaign] = await db
    .insert(campaigns)
    .values({ name: campaignName, subject: "test", fromName: "Carnival", fromEmail: "no-reply@example.com" })
    .returning();
  ids.campaignId = campaign.id;

  await db.insert(events).values([
    { contactId: ids.vip, type: "open", campaignId: ids.campaignId },
    { contactId: ids.standardOld, type: "click" },
  ]);
});

afterAll(cleanup);

describe("resolveSegmentContactIds", () => {
  it("contact_field: matches contacts by an allowlisted column", async () => {
    const segmentId = await createSegment("status-subscribed", {
      glue: "and",
      conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(new Set(result)).toEqual(new Set([ids.vip, ids.standardOld, ids.noOrders, ids.oldSignup]));
  });

  it("contact_field: createdAt withinDays matches only recent signups, as a rolling window rather than a fixed date", async () => {
    const segmentId = await createSegment("recent-signups", {
      glue: "and",
      conditions: [{ kind: "contact_field", field: "createdAt", op: "gte", withinDays: 30 }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    // Everyone except oldSignup (100 days ago) and unsub was just inserted by
    // this test, so they're all "recent" — op/value are ignored when
    // withinDays is set, so "gte" here is a deliberately unused placeholder.
    expect(new Set(result)).toEqual(new Set([ids.vip, ids.standardOld, ids.unsub, ids.noOrders]));
  });

  it("contact_attribute: matches a value inside the jsonb attributes column", async () => {
    const segmentId = await createSegment("tier-vip", {
      glue: "and",
      conditions: [{ kind: "contact_attribute", path: "tier", op: "eq", value: "vip" }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(result).toEqual([ids.vip]);
  });

  it("contact_attribute: 'contains' escapes % as a literal character instead of a wildcard", async () => {
    // vip has promo "ahorro50%" (literal percent); standardOld has
    // "ahorro50X" (no percent at all). Searching for the literal substring
    // "50%" must match only vip — the pre-fix behavior treated the %'s in
    // the search value as SQL LIKE wildcards, so "50%" became the pattern
    // %50%% (equivalent to just "contains 50"), matching standardOld too.
    const segmentId = await createSegment("promo-contains-percent", {
      glue: "and",
      conditions: [{ kind: "contact_attribute", path: "promo", op: "contains", value: "50%" }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(result).toEqual([ids.vip]);
  });

  it("list_membership: matches regardless of membership status when status is omitted", async () => {
    const segmentId = await createSegment("list-any-status", {
      glue: "and",
      conditions: [{ kind: "list_membership", listId: ids.listId }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(new Set(result)).toEqual(new Set([ids.vip, ids.noOrders, ids.unsub]));
  });

  it("list_membership: filters by membership status when given", async () => {
    const segmentId = await createSegment("list-subscribed-only", {
      glue: "and",
      conditions: [{ kind: "list_membership", listId: ids.listId, status: "subscribed" }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(new Set(result)).toEqual(new Set([ids.vip, ids.noOrders]));
  });

  it("order_exists (any): matches a purchase of a category within a window", async () => {
    const segmentId = await createSegment("bought-carne-30d", {
      glue: "and",
      conditions: [{ kind: "order_exists", op: "any", category: "carne", withinDays: 30 }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(result).toEqual([ids.vip]);
  });

  it("order_exists: filters by shipping method", async () => {
    const matching = await createSegment("shipped-flat-rate", {
      glue: "and",
      conditions: [{ kind: "order_exists", op: "any", shippingMethod: "flat_rate" }],
    });
    expect(await resolveSegmentContactIds(matching)).toEqual([ids.vip]);

    const nonMatching = await createSegment("shipped-local-pickup", {
      glue: "and",
      conditions: [{ kind: "order_exists", op: "any", shippingMethod: "local_pickup" }],
    });
    expect(await resolveSegmentContactIds(nonMatching)).toEqual([]);
  });

  it("order_exists (none): matches contacts with no purchase within a window", async () => {
    const segmentId = await createSegment("no-purchase-30d", {
      glue: "and",
      conditions: [{ kind: "order_exists", op: "none", withinDays: 30 }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(new Set(result)).toEqual(new Set([ids.standardOld, ids.unsub, ids.noOrders, ids.oldSignup]));
  });

  it("event_exists: matches by event type", async () => {
    const segmentId = await createSegment("clicked-anything", {
      glue: "and",
      conditions: [{ kind: "event_exists", op: "any", type: "click" }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(result).toEqual([ids.standardOld]);
  });

  it("event_exists: filters by campaignId when given", async () => {
    const matching = await createSegment("opened-this-campaign", {
      glue: "and",
      conditions: [{ kind: "event_exists", op: "any", type: "open", campaignId: ids.campaignId }],
    });
    expect(await resolveSegmentContactIds(matching)).toEqual([ids.vip]);

    const nonMatching = await createSegment("opened-other-campaign", {
      glue: "and",
      conditions: [{ kind: "event_exists", op: "any", type: "open", campaignId: 999999999 }],
    });
    expect(await resolveSegmentContactIds(nonMatching)).toEqual([]);
  });

  it("and: combines conditions with logical AND", async () => {
    const segmentId = await createSegment("subscribed-and-vip", {
      glue: "and",
      conditions: [
        { kind: "contact_field", field: "status", op: "eq", value: "subscribed" },
        { kind: "contact_attribute", path: "tier", op: "eq", value: "vip" },
      ],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(result).toEqual([ids.vip]);
  });

  it("or: combines conditions with logical OR", async () => {
    const segmentId = await createSegment("vip-or-bought-pollo", {
      glue: "or",
      conditions: [
        { kind: "contact_attribute", path: "tier", op: "eq", value: "vip" },
        { kind: "order_exists", op: "any", category: "pollo", withinDays: 9999 },
      ],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(new Set(result)).toEqual(new Set([ids.vip, ids.standardOld]));
  });

  it("nested groups: a group can contain another group", async () => {
    const segmentId = await createSegment("nested", {
      glue: "or",
      conditions: [
        {
          glue: "and",
          conditions: [
            { kind: "contact_field", field: "status", op: "eq", value: "subscribed" },
            { kind: "list_membership", listId: ids.listId, status: "subscribed" },
          ],
        },
        { kind: "event_exists", op: "any", type: "click" },
      ],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(new Set(result)).toEqual(new Set([ids.vip, ids.noOrders, ids.standardOld]));
  });

  it("excludes a contact tagged attributes.internal = 'true' even from a segment that never mentions it", async () => {
    // Same status as vip (subscribed) — would otherwise match this segment's
    // only condition just as readily as any real customer.
    const segmentId = await createSegment("subscribed-only", {
      glue: "and",
      conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }],
    });
    const result = await resolveSegmentContactIds(segmentId);
    expect(result).not.toContain(ids.internal);
  });
});

describe("countContactsMatchingRule", () => {
  it("counts matches for a rule that hasn't been saved as a segment", async () => {
    const count = await countContactsMatchingRule({
      glue: "and",
      conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }],
    });
    expect(count).toBe(4);
  });

  it("returns 0 when nothing matches", async () => {
    const count = await countContactsMatchingRule({
      glue: "and",
      conditions: [{ kind: "contact_attribute", path: "tier", op: "eq", value: "nonexistent-tier" }],
    });
    expect(count).toBe(0);
  });
});

describe("resolveSegmentContactsPage", () => {
  it("returns the real total alongside just the requested page, excluding internal-tagged contacts", async () => {
    const segmentId = await createSegment("page-status-subscribed", {
      glue: "and",
      conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }],
    });

    const firstPage = await resolveSegmentContactsPage(segmentId, { limit: 2, offset: 0 });
    const secondPage = await resolveSegmentContactsPage(segmentId, { limit: 2, offset: 2 });

    expect(firstPage.total).toBe(4);
    expect(secondPage.total).toBe(4);
    expect(firstPage.contacts).toHaveLength(2);
    expect(secondPage.contacts).toHaveLength(2);
    const allIds = [...firstPage.contacts, ...secondPage.contacts].map((c) => c.id);
    expect(new Set(allIds)).toEqual(new Set([ids.vip, ids.standardOld, ids.noOrders, ids.oldSignup]));
    expect(allIds).not.toContain(ids.internal);
  });

  it("throws for a nonexistent segment", async () => {
    await expect(resolveSegmentContactsPage(999999999, { limit: 10, offset: 0 })).rejects.toThrow("not found");
  });
});
