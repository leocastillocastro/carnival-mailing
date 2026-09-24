// Integration test against a real Postgres + Redis — needs
// `docker compose -f infra/docker-compose.yml up -d` running locally.
import { createQueuedSendsForCampaign, db, schema } from "@carnival/db";
import { createCampaignSendQueue, createRedisConnection } from "@carnival/queue";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueCampaignSends } from "../src/enqueue.js";

const { contacts, lists, contactLists, segments, campaigns, campaignSends, templates } = schema;

const emailDomain = "@campaigns-enqueue-test.example";
const listName = "campaigns-test:list";
const segmentName = "campaigns-test:segment";
const templateName = "campaigns-test:template";

const ids: {
  contactId: number;
  listId: number;
  segmentId: number;
  templateId: number;
  listCampaignId: number;
  segmentCampaignId: number;
} = {} as never;

// Jobs this test enqueues into the real BullMQ queue — removed in afterAll so
// they don't sit around waiting for a worker that will never process them.
const enqueuedSendIds: number[] = [];

async function cleanupPostgres() {
  const testContacts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.email, `%${emailDomain}`));
  const contactIds = testContacts.map((c) => c.id);
  await db.delete(campaigns).where(like(campaigns.name, "campaigns-test:%"));
  await db.delete(segments).where(eq(segments.name, segmentName));
  await db.delete(templates).where(eq(templates.name, templateName));
  if (contactIds.length > 0) {
    await db.delete(contactLists).where(eq(contactLists.listId, ids.listId ?? -1));
  }
  await db.delete(lists).where(eq(lists.name, listName));
  await db.delete(contacts).where(like(contacts.email, `%${emailDomain}`));
}

async function cleanupRedis() {
  if (enqueuedSendIds.length === 0) return;
  const connection = createRedisConnection();
  const queue = createCampaignSendQueue(connection);
  const jobs = await queue.getJobs(["wait", "delayed", "completed", "failed"]);
  await Promise.all(
    jobs
      .filter((job) => enqueuedSendIds.includes(job.data.campaignSendId))
      .map((job) => job.remove()),
  );
  await queue.close();
  connection.disconnect();
}

beforeAll(async () => {
  await cleanupPostgres();

  const [contact] = await db
    .insert(contacts)
    .values({ email: `member${emailDomain}`, status: "subscribed" })
    .returning();
  ids.contactId = contact.id;

  const [list] = await db.insert(lists).values({ name: listName }).returning();
  ids.listId = list.id;
  await db.insert(contactLists).values({ contactId: ids.contactId, listId: ids.listId, status: "subscribed" });

  const [segment] = await db
    .insert(segments)
    .values({
      name: segmentName,
      definition: { glue: "and", conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }] },
    })
    .returning();
  ids.segmentId = segment.id;

  const [template] = await db
    .insert(templates)
    .values({ name: templateName, htmlContent: "<p>test</p>" })
    .returning();
  ids.templateId = template.id;

  const [listCampaign] = await db
    .insert(campaigns)
    .values({
      name: "campaigns-test:list-campaign",
      subject: "test",
      fromName: "Carnival",
      fromEmail: "no-reply@example.com",
      templateId: ids.templateId,
      listId: ids.listId,
    })
    .returning();
  ids.listCampaignId = listCampaign.id;

  const [segmentCampaign] = await db
    .insert(campaigns)
    .values({
      name: "campaigns-test:segment-campaign",
      subject: "test",
      fromName: "Carnival",
      fromEmail: "no-reply@example.com",
      templateId: ids.templateId,
      segmentId: ids.segmentId,
    })
    .returning();
  ids.segmentCampaignId = segmentCampaign.id;
});

afterAll(async () => {
  await cleanupRedis();
  await cleanupPostgres();
});

describe("enqueueCampaignSends", () => {
  it("resolves a list-targeted campaign's audience and enqueues one send per contact", async () => {
    const result = await enqueueCampaignSends(ids.listCampaignId);
    expect(result).toEqual({ audienceSize: 1, queuedCount: 1 });

    const rows = await db.select().from(campaignSends).where(eq(campaignSends.campaignId, ids.listCampaignId));
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe(ids.contactId);
    expect(rows[0].status).toBe("queued");
    enqueuedSendIds.push(rows[0].id);
  });

  it("resolves a segment-targeted campaign's audience the same way", async () => {
    const result = await enqueueCampaignSends(ids.segmentCampaignId);
    expect(result).toEqual({ audienceSize: 1, queuedCount: 1 });

    const rows = await db.select().from(campaignSends).where(eq(campaignSends.campaignId, ids.segmentCampaignId));
    expect(rows).toHaveLength(1);
    enqueuedSendIds.push(rows[0].id);
  });

  it("is idempotent — re-running the same campaign queues nothing new and doesn't duplicate the BullMQ job", async () => {
    const [existingSend] = await db.select().from(campaignSends).where(eq(campaignSends.campaignId, ids.listCampaignId));

    const result = await enqueueCampaignSends(ids.listCampaignId);
    expect(result).toEqual({ audienceSize: 1, queuedCount: 0 });

    const connection = createRedisConnection();
    const queue = createCampaignSendQueue(connection);
    const jobs = await queue.getJobs(["wait"]);
    const matching = jobs.filter((j) => j.data.campaignSendId === existingSend.id);
    await queue.close();
    connection.disconnect();

    // Not 2 — the second enqueueCampaignSends call must not create a duplicate
    // job for a send id that's already in the queue.
    expect(matching).toHaveLength(1);
  });

  it("recovers a row left at 'queued' by a run that crashed before enqueuing its job", async () => {
    const [recoveryCampaign] = await db
      .insert(campaigns)
      .values({
        name: "campaigns-test:recovery-campaign",
        subject: "test",
        fromName: "Carnival",
        fromEmail: "no-reply@example.com",
        templateId: ids.templateId,
        listId: ids.listId,
      })
      .returning();

    // Simulate the crash window: the row exists (as createQueuedSendsForCampaign
    // would leave it) but no BullMQ job was ever created for it.
    const [orphanSend] = await createQueuedSendsForCampaign(recoveryCampaign.id, [ids.contactId]);
    enqueuedSendIds.push(orphanSend.id);

    const result = await enqueueCampaignSends(recoveryCampaign.id);
    expect(result.queuedCount).toBe(0); // no *new* db row this call — it already existed

    const connection = createRedisConnection();
    const queue = createCampaignSendQueue(connection);
    const jobs = await queue.getJobs(["wait"]);
    const job = jobs.find((j) => j.data.campaignSendId === orphanSend.id);
    await queue.close();
    connection.disconnect();

    expect(job).toBeDefined();
  });

  it("throws for a campaign with neither a list nor a segment", async () => {
    const [orphanCampaign] = await db
      .insert(campaigns)
      .values({
        name: "campaigns-test:orphan-campaign",
        subject: "test",
        fromName: "Carnival",
        fromEmail: "no-reply@example.com",
      })
      .returning();
    await expect(enqueueCampaignSends(orphanCampaign.id)).rejects.toThrow(/neither a listId nor a segmentId/);
  });

  it("throws for a campaign with a list but no template", async () => {
    const [noTemplateCampaign] = await db
      .insert(campaigns)
      .values({
        name: "campaigns-test:no-template-campaign",
        subject: "test",
        fromName: "Carnival",
        fromEmail: "no-reply@example.com",
        listId: ids.listId,
      })
      .returning();
    await expect(enqueueCampaignSends(noTemplateCampaign.id)).rejects.toThrow(/no templateId/);
  });
});
