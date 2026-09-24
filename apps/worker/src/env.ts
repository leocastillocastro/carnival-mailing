import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SES_REGION: z.string().min(1),
  SES_RATE_LIMIT_PER_SECOND: z.coerce.number().default(5),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
  // Public base URL of apps/api — used to build the pixel/click-tracking/unsubscribe
  // URLs embedded in outgoing emails (e.g. https://track.example.com).
  APP_BASE_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);
