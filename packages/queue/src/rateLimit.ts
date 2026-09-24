export interface LimiterOptions {
  max: number;
  duration: number;
}

/**
 * BullMQ's limiter needs an integer job count per window. SES quotas are often
 * fractional msgs/sec (e.g. sandbox default 1, some accounts 14.7) — flooring a
 * fractional rate straight to `max` over a 1s window would silently round down
 * (14.7 -> 14/s, losing ~5% throughput) or hit 0 for anything under 1/s. Instead
 * scale up to a wider window so the fractional part survives as whole jobs.
 */
export function computeLimiterOptions(ratePerSecond: number): LimiterOptions {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error(`rate per second must be a positive number, got ${ratePerSecond}`);
  }

  const windowSeconds = 10;
  const max = Math.max(1, Math.round(ratePerSecond * windowSeconds));
  return { max, duration: windowSeconds * 1000 };
}
