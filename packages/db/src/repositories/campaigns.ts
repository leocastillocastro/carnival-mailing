import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { campaignSends, campaigns, contactLists, contacts, lists, segments, templates } from "../schema.js";

export interface CampaignInput {
  name: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  templateId: number | null;
  contentFields: Record<string, string>;
  listId: number | null;
  segmentId: number | null;
}

export async function getCampaignById(id: number) {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return row ?? null;
}

export async function getAllCampaignsWithNames() {
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      subject: campaigns.subject,
      status: campaigns.status,
      sentAt: campaigns.sentAt,
      createdAt: campaigns.createdAt,
      listName: lists.name,
      segmentName: segments.name,
      templateName: templates.name,
    })
    .from(campaigns)
    .leftJoin(lists, eq(lists.id, campaigns.listId))
    .leftJoin(segments, eq(segments.id, campaigns.segmentId))
    .leftJoin(templates, eq(templates.id, campaigns.templateId))
    .orderBy(desc(campaigns.createdAt));
}

export async function getSentCampaignCount(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(campaigns).where(eq(campaigns.status, "sent"));
  return row?.count ?? 0;
}

/** For the home screen's "última campaña" stat — name + date only, no
 * engagement metric. Listmonk's own analytics implementation is reported as
 * confusing even by its maintainers (mismatched date-range pickers, "100%
 * opened" from one person opening 10 times) — a home-page stat tile is the
 * wrong place to attempt that; per-campaign stats already exist on each
 * campaign's own edit page. */
export async function getMostRecentSentCampaign() {
  const [row] = await db
    .select({ id: campaigns.id, name: campaigns.name, sentAt: campaigns.sentAt })
    .from(campaigns)
    .where(eq(campaigns.status, "sent"))
    .orderBy(desc(campaigns.sentAt))
    .limit(1);
  return row ?? null;
}

export async function createCampaign(input: CampaignInput) {
  const [row] = await db.insert(campaigns).values(input).returning();
  return row;
}

export async function updateCampaign(id: number, input: CampaignInput) {
  const [row] = await db.update(campaigns).set(input).where(eq(campaigns.id, id)).returning();
  return row ?? null;
}

export async function deleteCampaign(id: number) {
  await db.delete(campaigns).where(eq(campaigns.id, id));
}

export async function markCampaignSending(id: number) {
  await db.update(campaigns).set({ status: "sending" }).where(eq(campaigns.id, id));
}

/** Undoes `markCampaignSending` when enqueueing itself fails (e.g. Redis is
 * down) — without this, a campaign whose send was never actually queued is
 * indistinguishable from one genuinely in flight, and nothing else ever
 * revisits it (`finalizeCampaignIfDone` only runs from the enqueue success
 * path and from worker events, neither of which happens here). */
export async function revertCampaignStatus(
  id: number,
  status: "draft" | "scheduled" | "sending" | "sent" | "paused",
) {
  await db.update(campaigns).set({ status }).where(eq(campaigns.id, id));
}

export interface CampaignSendStat {
  status: string;
  count: number;
}

export async function getCampaignSendStats(campaignId: number): Promise<CampaignSendStat[]> {
  return db
    .select({ status: campaignSends.status, count: count() })
    .from(campaignSends)
    .where(eq(campaignSends.campaignId, campaignId))
    .groupBy(campaignSends.status);
}

const NON_TERMINAL_SEND_STATUSES = new Set(["queued", "sending"]);

/** Called by the worker whenever a `campaign_send` reaches a terminal state
 * (sent or failed), and once synchronously right after enqueueing — mainly
 * for a campaign whose audience matched zero contacts, which otherwise never
 * fires a single worker event to trigger this at all. `markCampaignSending`
 * is otherwise the only place that ever writes `campaigns.status`, so
 * without this a campaign shows "sending" forever, whether every send
 * succeeded, every one failed, or there was nothing to send in the first
 * place. An empty `stats` array (no campaign_sends rows at all) counts as
 * done, not as "still running" — safe because by the time this is ever
 * called, createQueuedSendsForCampaign has already run synchronously, so
 * empty genuinely means a zero-contact audience, not a race with rows not
 * inserted yet. Safe to call more than once for the same campaign (e.g. two
 * sends finishing at nearly the same moment under worker concurrency) — the
 * UPDATE is idempotent. Not distinguishing a fully-failed campaign with its
 * own status yet (would need a `campaign_status` enum migration) — the
 * per-status breakdown already shown on the campaign's edit page is where a
 * total failure becomes visible. */
export async function finalizeCampaignIfDone(campaignId: number): Promise<void> {
  const stats = await getCampaignSendStats(campaignId);
  const stillRunning = stats.some((stat) => NON_TERMINAL_SEND_STATUSES.has(stat.status));
  if (stillRunning) return;
  await db.update(campaigns).set({ status: "sent", sentAt: new Date() }).where(eq(campaigns.id, campaignId));
}

/** Same "not a staff/business account" filter segment resolution always
 * applies (see @carnival/segments' compileSegmentWhere) — a list-targeted
 * campaign has to go through this exact function, so without this check a
 * contact tagged attributes.internal="true" would receive a real campaign
 * whenever the audience is a list rather than a segment, contradicting the
 * whole point of that tag. Inlined rather than imported: packages/segments
 * depends on this package, not the other way around. */
export async function getSubscribedContactIdsForList(listId: number): Promise<number[]> {
  const rows = await db
    .select({ contactId: contactLists.contactId })
    .from(contactLists)
    .innerJoin(contacts, eq(contacts.id, contactLists.contactId))
    .where(
      and(
        eq(contactLists.listId, listId),
        eq(contactLists.status, "subscribed"),
        sql`${contacts.attributes} ->> 'internal' IS DISTINCT FROM 'true'`,
      ),
    );
  return rows.map((row) => row.contactId);
}
