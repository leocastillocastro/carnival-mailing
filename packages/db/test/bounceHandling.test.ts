import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { findContactByEmail, markContactStatus, upsertContactFromWoo } from "../src/repositories/contacts.js";
import { getCampaignSendByProviderMessageId, markCampaignSendBounced } from "../src/repositories/campaignSends.js";
import { recordEvent } from "../src/repositories/events.js";
import { campaigns, campaignSends, contacts, events, lists, templates } from "../src/schema.js";

const email = "audit-test-bounce@example.com";
const providerMessageId = "audit-test-ses-message-id-1";

async function seed() {
  const [list] = await db.insert(lists).values({ name: "Audit Test List" }).returning();
  const [template] = await db.insert(templates).values({ name: "Audit Test Template", htmlContent: "<p>hi</p>" }).returning();
  const contact = await upsertContactFromWoo({ email, wooCustomerId: 12345 });
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: "Audit Test Campaign",
      subject: "Hola",
      fromName: "Carnival",
      fromEmail: "newsletter@example.com",
      templateId: template.id,
      listId: list.id,
    })
    .returning();
  const [send] = await db
    .insert(campaignSends)
    .values({ campaignId: campaign.id, contactId: contact.id, trackingToken: "audit-test-token", providerMessageId })
    .returning();
  return { list, template, contact, campaign, send };
}

afterEach(async () => {
  const send = await getCampaignSendByProviderMessageId(providerMessageId);
  if (send) {
    await db.delete(events).where(eq(events.sendId, send.id));
    await db.delete(campaignSends).where(eq(campaignSends.id, send.id));
    await db.delete(campaigns).where(eq(campaigns.id, send.campaignId));
  }
  await db.delete(contacts).where(eq(contacts.email, email));
  await db.delete(templates).where(eq(templates.name, "Audit Test Template"));
  await db.delete(lists).where(eq(lists.name, "Audit Test List"));
});

describe("bounce/complaint repositories", () => {
  it("finds the campaign_send by the SES provider message id", async () => {
    const { send } = await seed();
    const found = await getCampaignSendByProviderMessageId(providerMessageId);
    expect(found?.id).toBe(send.id);
  });

  it("returns null for an unknown provider message id", async () => {
    expect(await getCampaignSendByProviderMessageId("no-such-message-id")).toBeNull();
  });

  it("marks a campaign_send bounced with the bounce reason as the error", async () => {
    const { send } = await seed();
    await markCampaignSendBounced(send.id, "Permanent/General");
    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("bounced");
    expect(row.error).toBe("Permanent/General");
  });

  it("updates the contact's status", async () => {
    const { contact } = await seed();
    await markContactStatus(contact.id, "complained");
    const row = await findContactByEmail(email);
    expect(row?.status).toBe("complained");
  });

  it("records a bounce event linked to the contact, campaign, and send", async () => {
    const { contact, campaign, send } = await seed();
    const event = await recordEvent({ contactId: contact.id, campaignId: campaign.id, sendId: send.id, type: "bounce" });
    expect(event.type).toBe("bounce");
    expect(event.contactId).toBe(contact.id);
    expect(event.sendId).toBe(send.id);
  });
});
