import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../client.js";
import { campaigns, campaignSends, contacts, templates } from "../schema.js";

// `pg`'s extended protocol has a hard 65535-bound-parameter ceiling per query
// (3 params per row here — campaignId, contactId, trackingToken — puts that
// at ~21,845 rows). 5,000 rows per INSERT stays comfortably under that even
// if a row ever gained another column, without needing to tune this again as
// the subscriber list grows.
const INSERT_CHUNK_SIZE = 5000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Bulk-inserts queued sends for a campaign. Relies on the unique (campaignId, contactId)
 * index to make re-running the enqueue step for the same campaign idempotent —
 * true per chunk too, so a crash partway through a large audience just leaves
 * the remaining chunks to insert (or re-insert, harmlessly) on the next call. */
export async function createQueuedSendsForCampaign(campaignId: number, contactIds: number[]) {
  const inserted: (typeof campaignSends.$inferSelect)[] = [];
  for (const batch of chunk(contactIds, INSERT_CHUNK_SIZE)) {
    const rows = await db
      .insert(campaignSends)
      .values(
        batch.map((contactId) => ({
          campaignId,
          contactId,
          trackingToken: randomBytes(16).toString("hex"),
        })),
      )
      .onConflictDoNothing({ target: [campaignSends.campaignId, campaignSends.contactId] })
      .returning();
    inserted.push(...rows);
  }
  return inserted;
}

/** Every row still at `queued` for a campaign — not just ones inserted in the
 * current call. Used to recover rows left behind by a crash between inserting
 * them and enqueuing their BullMQ job (see enqueueCampaignSends). */
export async function getQueuedCampaignSendIds(campaignId: number): Promise<number[]> {
  const rows = await db
    .select({ id: campaignSends.id })
    .from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), eq(campaignSends.status, "queued")));
  return rows.map((row) => row.id);
}

export interface CampaignSendDetail {
  id: number;
  campaignId: number;
  status: string;
  trackingToken: string;
  contactEmail: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactAttributes: Record<string, unknown>;
  fromEmail: string;
  fromName: string;
  subject: string;
  templateHtml: string;
  campaignContentFields: Record<string, string>;
}

export async function getCampaignSendDetail(id: number): Promise<CampaignSendDetail | null> {
  const [row] = await db
    .select({
      id: campaignSends.id,
      campaignId: campaignSends.campaignId,
      status: campaignSends.status,
      trackingToken: campaignSends.trackingToken,
      contactEmail: contacts.email,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactAttributes: contacts.attributes,
      fromEmail: campaigns.fromEmail,
      fromName: campaigns.fromName,
      subject: campaigns.subject,
      templateHtml: templates.htmlContent,
      campaignContentFields: campaigns.contentFields,
    })
    .from(campaignSends)
    .innerJoin(contacts, eq(contacts.id, campaignSends.contactId))
    .innerJoin(campaigns, eq(campaigns.id, campaignSends.campaignId))
    .innerJoin(templates, eq(templates.id, campaigns.templateId))
    .where(eq(campaignSends.id, id))
    .limit(1);
  return (row as CampaignSendDetail | undefined) ?? null;
}

/** Deliberately independent of getCampaignSendDetail, which inner-joins
 * templates via campaigns.templateId — a send whose campaign has no
 * template (the exact case finalizeCampaignIfDone needs to resolve status
 * for) would silently fail that join and never reach this lookup. */
export async function getCampaignIdForSend(sendId: number): Promise<number | null> {
  const [row] = await db.select({ campaignId: campaignSends.campaignId }).from(campaignSends).where(eq(campaignSends.id, sendId)).limit(1);
  return row?.campaignId ?? null;
}

export interface CampaignSendTrackingRef {
  id: number;
  campaignId: number;
  contactId: number;
}

/** Looks up the send behind a tracking token — the only recipient identifier
 * ever placed in a pixel/click-redirect URL, never a raw contact id or email. */
export async function getCampaignSendByTrackingToken(
  trackingToken: string,
): Promise<CampaignSendTrackingRef | null> {
  const [row] = await db
    .select({ id: campaignSends.id, campaignId: campaignSends.campaignId, contactId: campaignSends.contactId })
    .from(campaignSends)
    .where(eq(campaignSends.trackingToken, trackingToken))
    .limit(1);
  return row ?? null;
}

export interface ContactByTrackingToken {
  contactId: number;
  email: string;
  campaignId: number;
  sendId: number;
}

/** Same token used by the pixel/click routes, resolved to the contact's email —
 * unsubscribing/resubscribing acts on the email (suppressions' identity), not
 * just the contact row. */
export async function getContactByTrackingToken(trackingToken: string): Promise<ContactByTrackingToken | null> {
  const [row] = await db
    .select({
      contactId: contacts.id,
      email: contacts.email,
      campaignId: campaignSends.campaignId,
      sendId: campaignSends.id,
    })
    .from(campaignSends)
    .innerJoin(contacts, eq(contacts.id, campaignSends.contactId))
    .where(eq(campaignSends.trackingToken, trackingToken))
    .limit(1);
  return row ?? null;
}

/** Atomic claim: only transitions `queued` → `sending`, and reports whether it
 * actually did. SES gives no idempotency/dedup mechanism of its own, so this
 * CAS is what makes "sending" unambiguous — paired with revertCampaignSendToQueued
 * below, "sending" can only mean "an attempt is genuinely in flight (or its
 * process died before it could revert)", never "known failed, safe to retry".
 * A caller that fails to claim a row already at `sending` is looking at the
 * result of exactly that crash scenario. */
export async function claimCampaignSendForSending(id: number): Promise<boolean> {
  const rows = await db
    .update(campaignSends)
    .set({ status: "sending", claimedAt: new Date() })
    .where(and(eq(campaignSends.id, id), eq(campaignSends.status, "queued")))
    .returning({ id: campaignSends.id });
  return rows.length > 0;
}

/** Undoes the claim above after a *handled* send failure (SES threw, we
 * caught it) — the row goes back to `queued` so the next retry can claim it
 * cleanly, instead of leaving it at `sending` where it would be
 * indistinguishable from a crashed-mid-send attempt. Scoped to `sending`
 * (like the claim itself) so a late/duplicate call from a stalled BullMQ job
 * that's still running in parallel with its own retry can't undo a status
 * some other, faster execution already resolved. */
export async function revertCampaignSendToQueued(id: number): Promise<void> {
  await db
    .update(campaignSends)
    .set({ status: "queued" })
    .where(and(eq(campaignSends.id, id), eq(campaignSends.status, "sending")));
}

/** Scoped to `sending` — only the execution that's actually resolving *this*
 * send attempt should get to write its outcome. Without this, a stalled
 * BullMQ job that's still alive and running in parallel with its own retry
 * (see worker.ts) could silently overwrite a status a faster, correct
 * execution already settled — a delivered send reported as failed, or vice
 * versa, with no error anywhere to reveal it happened. Doesn't affect the
 * separate, legitimate sent → bounced/complained transition below, which
 * intentionally fires later, from an SES webhook, against a row already at
 * `sent`. */
export async function markCampaignSendSent(id: number, providerMessageId: string) {
  await db
    .update(campaignSends)
    .set({ status: "sent", sentAt: new Date(), providerMessageId })
    .where(and(eq(campaignSends.id, id), eq(campaignSends.status, "sending")));
}

/** Called both while a row is still `sending` (the "ambiguous previous
 * attempt" claim-failure path in processCampaignSend) and after it's already
 * back at `queued` (worker.ts's "failed" handler, once BullMQ's retries are
 * exhausted — processCampaignSend's catch always reverts to `queued` first,
 * *before* that event ever fires) — so the guard has to allow either
 * non-terminal state, not just `sending`. */
export async function markCampaignSendFailed(id: number, error: string) {
  await db
    .update(campaignSends)
    .set({ status: "failed", error })
    .where(and(eq(campaignSends.id, id), inArray(campaignSends.status, ["queued", "sending"])));
}

export async function markCampaignSendBounced(id: number, error: string) {
  await db.update(campaignSends).set({ status: "bounced", error }).where(eq(campaignSends.id, id));
}

/** Distinct from bounced: a bounce means the message never reached an inbox,
 * a complaint means it did and the recipient reported it as spam. Without
 * this, a complained send stayed reported as "sent" forever in per-campaign
 * stats even though the contact/event tables correctly recorded the
 * complaint — undercounting complaints anywhere that reads send-level status. */
export async function markCampaignSendComplained(id: number) {
  await db.update(campaignSends).set({ status: "complained" }).where(eq(campaignSends.id, id));
}

/** SES bounce/complaint notifications carry the original message id back —
 * this is how a bounce gets correlated to the specific campaign_send that sent it. */
export async function getCampaignSendByProviderMessageId(providerMessageId: string) {
  const [row] = await db
    .select()
    .from(campaignSends)
    .where(eq(campaignSends.providerMessageId, providerMessageId))
    .limit(1);
  return row ?? null;
}

export async function markCampaignSendSuppressed(id: number) {
  await db.update(campaignSends).set({ status: "suppressed" }).where(eq(campaignSends.id, id));
}

/** Safety net for the case none of the CAS/claim machinery above can fully
 * close on its own: a worker process that crashes (or a BullMQ job that
 * stalls past `maxStalledCount` and gets failed by BullMQ *before* its own
 * `attempts` are exhausted — a real, documented BullMQ behavior, not just a
 * hypothetical) can leave a row at `sending` with nothing left to ever claim
 * it, revert it, or fail it — the campaign then shows "sending" forever with
 * no error anywhere to explain why. This finds every row stuck at `sending`
 * longer than `olderThanMinutes` (a real attempt has no legitimate reason to
 * take anywhere near that long — a single SES call is a sub-second HTTP
 * request) and marks it failed for a human to verify, exactly like the
 * "ambiguous previous attempt" case already handles the same uncertainty
 * about whether SES actually got the message. Returns the distinct campaign
 * ids touched, so the caller can run finalizeCampaignIfDone on each — kept
 * out of this function to avoid a circular import with campaigns.ts. */
export async function reapStuckSends(olderThanMinutes: number): Promise<number[]> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await db
    .update(campaignSends)
    .set({
      status: "failed",
      error: `stuck at "sending" for longer than ${olderThanMinutes} minutes (worker crash or a BullMQ job that failed before its own retries were exhausted) — outcome unknown, verify manually before resending`,
    })
    .where(
      and(
        eq(campaignSends.status, "sending"),
        lt(campaignSends.claimedAt, cutoff),
      ),
    )
    .returning({ campaignId: campaignSends.campaignId });
  return [...new Set(rows.map((row) => row.campaignId))];
}
