import { Redis } from "ioredis";

/** Each Queue/Worker gets its own connection — BullMQ's Worker holds its connection
 * in blocking mode, so it can't be shared with a Queue producer. */
export function createRedisConnection(): Redis {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set");
  }
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
