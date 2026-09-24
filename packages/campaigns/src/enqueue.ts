import {
  createQueuedSendsForCampaign,
  getCampaignById,
  getQueuedCampaignSendIds,
  getSubscribedContactIdsForList,
} from "@carnival/db";
import { createCampaignSendQueue, createRedisConnection } from "@carnival/queue";
import { resolveSegmentContactIds } from "@carnival/segments";

export interface EnqueueCampaignResult {
  audienceSize: number;
  queuedCount: number;
}

/** Resolves a campaign's audience (list or segment — exactly one is set) and
 * enqueues a BullMQ job per `campaign_send` row still at `queued`. Shared by
 * the CLI script (`apps/api/scripts/sendCampaign.ts`) and the admin "send now"
 * action so both go through one code path instead of two copies drifting. */
export async function enqueueCampaignSends(campaignId: number): Promise<EnqueueCampaignResult> {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    throw new Error(`campaign ${campaignId} not found`);
  }
  if (!campaign.listId && !campaign.segmentId) {
    throw new Error(`campaign ${campaignId} has neither a listId nor a segmentId`);
  }
  // The admin form already requires a template, but a campaign could still
  // reach here without one (a template deleted after the campaign was
  // created) — without this check, every send would silently fail in the
  // worker with a misleading "campaign_send X not found" (the inner join on
  // a null templateId in getCampaignSendDetail matches nothing).
  if (!campaign.templateId) {
    throw new Error(`campaign ${campaignId} has no templateId`);
  }

  const contactIds = campaign.listId
    ? await getSubscribedContactIdsForList(campaign.listId)
    : await resolveSegmentContactIds(campaign.segmentId!);
  const newSends = await createQueuedSendsForCampaign(campaignId, contactIds);

  // Re-fetch every row still `queued` — not just the ones just inserted above
  // — so a previous run that crashed between inserting rows and enqueuing
  // their jobs gets a chance to recover here instead of leaving them stuck
  // forever. Giving each job a deterministic id (the row's own id) makes this
  // safe to repeat: BullMQ treats re-adding an id that's already in the queue
  // as a no-op rather than creating a duplicate, so nothing gets double-sent.
  const queuedSendIds = await getQueuedCampaignSendIds(campaignId);

  const connection = createRedisConnection();
  const queue = createCampaignSendQueue(connection);
  try {
    await queue.addBulk(
      queuedSendIds.map((sendId) => ({
        name: "send",
        data: { campaignSendId: sendId },
        // BullMQ rejects a purely-numeric custom jobId (reserved for its own
        // auto-incrementing ids) and one containing ':' (reserved for
        // repeatable-job ids), hence the dash-prefixed form.
        opts: { jobId: `campaign-send-${sendId}` },
      })),
    );
  } finally {
    await queue.close();
    connection.disconnect();
  }

  return { audienceSize: contactIds.length, queuedCount: newSends.length };
}
