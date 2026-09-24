import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { finalizeCampaignIfDone, getMostRecentSentCampaign, getSentCampaignCount } from "../src/repositories/campaigns.js";
import {
  claimCampaignSendForSending,
  getCampaignIdForSend,
  markCampaignSendFailed,
  markCampaignSendSent,
  reapStuckSends,
  revertCampaignSendToQueued,
} from "../src/repositories/campaignSends.js";
import { upsertContactFromWoo } from "../src/repositories/contacts.js";
import { campaigns, campaignSends, contacts, templates } from "../src/schema.js";

const email = "audit-test-campaignsends@example.com";

async function seed() {
  const contact = await upsertContactFromWoo({ email, wooCustomerId: 987654 });
  const [template] = await db
    .insert(templates)
    .values({ name: "Audit Test Template (campaignSends)", htmlContent: "<p>hi</p>" })
    .returning();
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: "Audit Test Campaign (campaignSends)",
      subject: "Hola",
      fromName: "Carnival",
      fromEmail: "newsletter@example.com",
      templateId: template.id,
    })
    .returning();
  const [send] = await db
    .insert(campaignSends)
    .values({ campaignId: campaign.id, contactId: contact.id, trackingToken: "audit-test-campaignsends-token" })
    .returning();
  return { contact, template, campaign, send };
}

afterEach(async () => {
  const rows = await db.select().from(campaignSends).where(eq(campaignSends.trackingToken, "audit-test-campaignsends-token"));
  for (const row of rows) {
    await db.delete(campaignSends).where(eq(campaignSends.id, row.id));
    await db.delete(campaigns).where(eq(campaigns.id, row.campaignId));
  }
  await db.delete(templates).where(eq(templates.name, "Audit Test Template (campaignSends)"));
  await db.delete(contacts).where(eq(contacts.email, email));
});

describe("claimCampaignSendForSending", () => {
  it("claims a queued row and transitions it to sending", async () => {
    const { send } = await seed();
    expect(await claimCampaignSendForSending(send.id)).toBe(true);

    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("sending");
  });

  it("fails to claim a row that isn't at queued (the crash-recovery signal)", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id); // now "sending"

    expect(await claimCampaignSendForSending(send.id)).toBe(false);
  });

  it("only one of two concurrent claims on the same row succeeds", async () => {
    const { send } = await seed();

    const [first, second] = await Promise.all([
      claimCampaignSendForSending(send.id),
      claimCampaignSendForSending(send.id),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe("revertCampaignSendToQueued", () => {
  it("puts a claimed row back to queued so it can be claimed again", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id);

    await revertCampaignSendToQueued(send.id);

    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("queued");
    expect(await claimCampaignSendForSending(send.id)).toBe(true);
  });

  it("does not touch a row a faster execution already resolved to sent (scoped to 'sending')", async () => {
    // The scenario this guards against: a stalled BullMQ job that's still
    // alive in the event loop, racing its own retry. Without this guard, a
    // late revert from the stalled copy could put a genuinely-delivered send
    // back to "queued" for no reason, risking a real duplicate resend.
    const { send } = await seed();
    await claimCampaignSendForSending(send.id);
    await markCampaignSendSent(send.id, "ses-message-id");

    await revertCampaignSendToQueued(send.id);

    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("sent");
  });
});

describe("markCampaignSendSent / markCampaignSendFailed", () => {
  it("markCampaignSendSent only applies from 'sending' — a late duplicate can't overwrite an already-failed row", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id);
    await markCampaignSendFailed(send.id, "definitely rejected by SES");

    await markCampaignSendSent(send.id, "late-duplicate-message-id");

    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("failed");
  });

  it("markCampaignSendFailed only applies while non-terminal — a late duplicate can't overwrite an already-sent row", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id);
    await markCampaignSendSent(send.id, "ses-message-id");

    await markCampaignSendFailed(send.id, "late-duplicate-failure");

    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("sent");
  });

  it("markCampaignSendFailed still applies from 'queued' — the real path once processCampaignSend's catch already reverted the row before BullMQ's retries are exhausted", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id);
    await revertCampaignSendToQueued(send.id); // what processCampaignSend's catch does on every handled failure

    await markCampaignSendFailed(send.id, "retries exhausted");

    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("failed");
  });
});

describe("reapStuckSends", () => {
  it("marks a send failed once it's been stuck at 'sending' longer than the threshold", async () => {
    const { send, campaign } = await seed();
    await claimCampaignSendForSending(send.id);
    // Simulate a claim old enough to count as stuck — claimCampaignSendForSending
    // itself always sets claimedAt to "now", so backdating it directly is the
    // only way to exercise this without actually waiting.
    await db
      .update(campaignSends)
      .set({ claimedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(campaignSends.id, send.id));

    const affected = await reapStuckSends(15);

    expect(affected).toEqual([campaign.id]);
    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/stuck at "sending"/);
  });

  it("leaves a recently-claimed send alone — still plausibly in flight", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id); // claimedAt = now

    const affected = await reapStuckSends(15);

    expect(affected).toEqual([]);
    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("sending");
  });

  it("never touches a row that isn't at 'sending', however old its claimedAt is", async () => {
    const { send } = await seed();
    await claimCampaignSendForSending(send.id);
    await markCampaignSendSent(send.id, "ses-message-id");
    await db
      .update(campaignSends)
      .set({ claimedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(campaignSends.id, send.id));

    const affected = await reapStuckSends(15);

    expect(affected).toEqual([]);
    const [row] = await db.select().from(campaignSends).where(eq(campaignSends.id, send.id));
    expect(row.status).toBe("sent");
  });
});

describe("getCampaignIdForSend", () => {
  it("returns the campaign id for a real send", async () => {
    const { send, campaign } = await seed();
    expect(await getCampaignIdForSend(send.id)).toBe(campaign.id);
  });

  it("returns null for a nonexistent send id", async () => {
    expect(await getCampaignIdForSend(999999999)).toBeNull();
  });
});

describe("finalizeCampaignIfDone", () => {
  it("marks a campaign with zero campaign_sends rows sent — the one case no worker event ever fires for", async () => {
    // A campaign whose audience matched no contacts: enqueueCampaignSends
    // creates no rows at all, so no worker "completed"/"failed" event will
    // ever exist to trigger finalization on its own.
    const [template] = await db
      .insert(templates)
      .values({ name: "Audit Test Template (campaignSends, empty audience)", htmlContent: "<p>hi</p>" })
      .returning();
    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: "Audit Test Campaign (campaignSends, empty audience)",
        subject: "Hola",
        fromName: "Carnival",
        fromEmail: "newsletter@example.com",
        templateId: template.id,
        status: "sending",
      })
      .returning();

    await finalizeCampaignIfDone(campaign.id);

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.status).toBe("sent");

    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
    await db.delete(templates).where(eq(templates.id, template.id));
  });

  it("does nothing while a send is still queued or sending", async () => {
    const { send, campaign } = await seed();
    await claimCampaignSendForSending(send.id); // now "sending", not terminal

    await finalizeCampaignIfDone(campaign.id);

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.status).not.toBe("sent");
  });

  it("marks the campaign sent (with sentAt) once every send has reached a terminal state", async () => {
    const { send, campaign } = await seed();
    await db.update(campaignSends).set({ status: "sent" }).where(eq(campaignSends.id, send.id));

    await finalizeCampaignIfDone(campaign.id);

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
  });

  it("also resolves to sent when every send failed — the failure breakdown, not the top-level status, communicates that", async () => {
    const { send, campaign } = await seed();
    await db.update(campaignSends).set({ status: "failed", error: "boom" }).where(eq(campaignSends.id, send.id));

    await finalizeCampaignIfDone(campaign.id);

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.status).toBe("sent");
  });

  it("waits for ALL sends to be terminal, not just one, when a campaign has several recipients", async () => {
    const { send, campaign } = await seed();
    const contact2 = await upsertContactFromWoo({ email: "audit-test-campaignsends-2@example.com", wooCustomerId: 987655 });
    const [send2] = await db
      .insert(campaignSends)
      .values({ campaignId: campaign.id, contactId: contact2.id, trackingToken: "audit-test-campaignsends-token-2" })
      .returning();

    await db.update(campaignSends).set({ status: "sent" }).where(eq(campaignSends.id, send.id));
    // send2 is still "queued" — campaign must not resolve yet.
    await finalizeCampaignIfDone(campaign.id);
    let [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.status).not.toBe("sent");

    await db.update(campaignSends).set({ status: "sent" }).where(eq(campaignSends.id, send2.id));
    await finalizeCampaignIfDone(campaign.id);
    [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.status).toBe("sent");

    await db.delete(campaignSends).where(eq(campaignSends.id, send2.id));
    await db.delete(contacts).where(eq(contacts.email, "audit-test-campaignsends-2@example.com"));
  });
});

describe("getSentCampaignCount / getMostRecentSentCampaign", () => {
  // Home screen stats — this database is shared (real data alongside test
  // rows), so counts are asserted as a delta, not an absolute number.
  it("counts only sent campaigns and returns the most recently sent one by date", async () => {
    const before = await getSentCampaignCount();

    const [older] = await db
      .insert(campaigns)
      .values({
        name: "Audit Test Campaign (home stats, older)",
        subject: "Hola",
        fromName: "Carnival",
        fromEmail: "newsletter@example.com",
        status: "sent",
        sentAt: new Date(Date.now() - 60_000),
      })
      .returning();
    const [newer] = await db
      .insert(campaigns)
      .values({
        name: "Audit Test Campaign (home stats, newer)",
        subject: "Hola",
        fromName: "Carnival",
        fromEmail: "newsletter@example.com",
        status: "sent",
        sentAt: new Date(),
      })
      .returning();
    const [draft] = await db
      .insert(campaigns)
      .values({
        name: "Audit Test Campaign (home stats, draft)",
        subject: "Hola",
        fromName: "Carnival",
        fromEmail: "newsletter@example.com",
      })
      .returning();

    expect(await getSentCampaignCount()).toBe(before + 2);
    expect((await getMostRecentSentCampaign())?.id).toBe(newer.id);

    await db.delete(campaigns).where(eq(campaigns.id, older.id));
    await db.delete(campaigns).where(eq(campaigns.id, newer.id));
    await db.delete(campaigns).where(eq(campaigns.id, draft.id));
  });
});
