import { env } from "./env.js";
import { finalizeCampaignIfDone, getCampaignIdForSend, markCampaignSendFailed, reapStuckSends } from "@carnival/db";
import { CAMPAIGN_SEND_QUEUE_NAME, computeLimiterOptions, createRedisConnection, type CampaignSendJobData } from "@carnival/queue";
import { Worker } from "bullmq";
import { processCampaignSend } from "./processCampaignSend.js";
import { isFinalAttempt } from "./retryPolicy.js";

// markCampaignSending (set when "Enviar ahora" enqueues) is otherwise the
// only place that ever writes campaigns.status — without this, a campaign
// shows "sending" forever whether every send succeeded or every one failed.
// Safe to call after every single send that reaches a terminal state (not
// just the last one) since it's a no-op until none remain queued/sending.
async function maybeFinalizeCampaign(campaignSendId: number) {
  const campaignId = await getCampaignIdForSend(campaignSendId);
  if (campaignId !== null) await finalizeCampaignIfDone(campaignId);
}

const worker = new Worker<CampaignSendJobData>(
  CAMPAIGN_SEND_QUEUE_NAME,
  (job) => processCampaignSend(job.data.campaignSendId),
  {
    connection: createRedisConnection(),
    concurrency: env.WORKER_CONCURRENCY,
    limiter: computeLimiterOptions(env.SES_RATE_LIMIT_PER_SECOND),
  },
);

worker.on("completed", async (job, result) => {
  console.log(`campaign_send ${job.data.campaignSendId}: ${JSON.stringify(result)}`);
  await maybeFinalizeCampaign(job.data.campaignSendId);
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  console.error(
    `campaign_send ${job.data.campaignSendId} attempt ${job.attemptsMade}/${attempts} failed: ${err.message}`,
  );
  if (isFinalAttempt(job.attemptsMade, attempts)) {
    await markCampaignSendFailed(job.data.campaignSendId, err.message);
    await maybeFinalizeCampaign(job.data.campaignSendId);
  }
});

// Safety net for a send that's stuck at "sending" with nothing left to ever
// resolve it — a crashed worker, or a BullMQ job stalled and failed by
// BullMQ itself before its own retries were exhausted (see reapStuckSends'
// own doc comment). A real attempt is a single sub-second SES call, plus at
// most ~75s of BullMQ's own retry backoff (5 attempts, exponential from 5s) —
// 15 minutes is a wide margin over any legitimate in-flight time.
const REAP_INTERVAL_MS = 5 * 60_000;
const REAP_STUCK_AFTER_MINUTES = 15;

async function reapAndFinalize() {
  try {
    const affectedCampaignIds = await reapStuckSends(REAP_STUCK_AFTER_MINUTES);
    for (const campaignId of affectedCampaignIds) {
      console.error(`campaign ${campaignId}: reaped one or more sends stuck at "sending" past ${REAP_STUCK_AFTER_MINUTES} minutes`);
      await finalizeCampaignIfDone(campaignId);
    }
  } catch (err) {
    console.error("reapStuckSends failed", err);
  }
}

const reapInterval = setInterval(() => void reapAndFinalize(), REAP_INTERVAL_MS);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, finishing in-flight jobs before exit...`);
  clearInterval(reapInterval);
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(
  `worker listening on queue "${CAMPAIGN_SEND_QUEUE_NAME}" (concurrency=${env.WORKER_CONCURRENCY}, rate=${env.SES_RATE_LIMIT_PER_SECOND}/s)`,
);
