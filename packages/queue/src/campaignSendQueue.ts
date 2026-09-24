import type { Redis } from "ioredis";
import { Queue } from "bullmq";
import { createRedisConnection } from "./connection.js";

export const CAMPAIGN_SEND_QUEUE_NAME = "campaign-sends";

export interface CampaignSendJobData {
  campaignSendId: number;
}

/** BullMQ never closes a connection it didn't create itself, so callers that pass
 * their own `connection` (or get the default one) must disconnect it after `queue.close()`. */
export function createCampaignSendQueue(connection: Redis = createRedisConnection()): Queue<CampaignSendJobData> {
  return new Queue<CampaignSendJobData>(CAMPAIGN_SEND_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    },
  });
}
