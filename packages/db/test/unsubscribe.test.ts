import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { getContactByTrackingToken } from "../src/repositories/campaignSends.js";
import { findContactByEmail, resubscribeContact, unsubscribeContact, upsertContactFromWoo } from "../src/repositories/contacts.js";
import { addSuppression, isEmailSuppressed, removeSuppression } from "../src/repositories/suppressions.js";
import { campaigns, campaignSends, contacts, lists, templates } from "../src/schema.js";

const email = "audit-test-unsubscribe@example.com";
const trackingToken = "audit-test-unsubscribe-token";

async function seed() {
  const [list] = await db.insert(lists).values({ name: "Audit Test List (unsub)" }).returning();
  const [template] = await db.insert(templates).values({ name: "Audit Test Template (unsub)", htmlContent: "<p>hi</p>" }).returning();
  const contact = await upsertContactFromWoo({ email, wooCustomerId: 54321 });
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: "Audit Test Campaign (unsub)",
      subject: "Hola",
      fromName: "Carnival",
      fromEmail: "newsletter@example.com",
      templateId: template.id,
      listId: list.id,
    })
    .returning();
  const [send] = await db
    .insert(campaignSends)
    .values({ campaignId: campaign.id, contactId: contact.id, trackingToken })
    .returning();
  return { list, template, contact, campaign, send };
}

afterEach(async () => {
  const found = await getContactByTrackingToken(trackingToken);
  if (found) {
    await db.delete(campaignSends).where(eq(campaignSends.id, found.sendId));
    await db.delete(campaigns).where(eq(campaigns.id, found.campaignId));
  }
  await removeSuppression(email, "unsubscribe");
  await db.delete(contacts).where(eq(contacts.email, email));
  await db.delete(templates).where(eq(templates.name, "Audit Test Template (unsub)"));
  await db.delete(lists).where(eq(lists.name, "Audit Test List (unsub)"));
});

describe("unsubscribe/resubscribe repositories", () => {
  it("resolves the contact's email and campaign/send ids by tracking token", async () => {
    const { contact, campaign, send } = await seed();
    const found = await getContactByTrackingToken(trackingToken);
    expect(found).toEqual({ contactId: contact.id, email, campaignId: campaign.id, sendId: send.id });
  });

  it("returns null for an unknown tracking token", async () => {
    expect(await getContactByTrackingToken("no-such-token")).toBeNull();
  });

  it("unsubscribeContact marks the contact unsubscribed with a timestamp", async () => {
    const { contact } = await seed();
    await unsubscribeContact(contact.id);
    const row = await findContactByEmail(email);
    expect(row?.status).toBe("unsubscribed");
    expect(row?.unsubscribedAt).not.toBeNull();
  });

  it("resubscribeContact reverses it and clears the timestamp", async () => {
    const { contact } = await seed();
    await unsubscribeContact(contact.id);
    await resubscribeContact(contact.id);
    const row = await findContactByEmail(email);
    expect(row?.status).toBe("subscribed");
    expect(row?.unsubscribedAt).toBeNull();
  });

  it("removeSuppression undoes addSuppression", async () => {
    await seed();
    await addSuppression(email, "unsubscribe");
    expect(await isEmailSuppressed(email)).toBe(true);

    await removeSuppression(email, "unsubscribe");
    expect(await isEmailSuppressed(email)).toBe(false);
  });
});
