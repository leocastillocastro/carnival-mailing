import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { syncLog } from "../schema.js";

export type ClaimResult = "claimed" | "duplicate";

/**
 * Atomically claims a webhook delivery id before any processing happens, so
 * two concurrent deliveries of the same id (a legitimate retry from
 * WooCommerce/SNS, or a replayed signed request) can't both pass a
 * check-then-act "was this already processed?" query and both run the
 * side effects. externalId === null means the delivery can't be deduped at
 * all (no id to key on) — always claims.
 *
 * A single INSERT ... ON CONFLICT ... DO UPDATE ... WHERE does the whole
 * thing in one atomic statement: a brand-new id inserts normally; an id
 * whose previous attempt is still `processing` or already `processed` hits
 * the WHERE guard and updates nothing (Postgres treats that exactly like DO
 * NOTHING — no row returned); an id whose previous attempt ended in
 * `failed` is allowed to reclaim it, so a retried delivery still gets
 * reprocessed instead of being stuck as a permanent duplicate.
 */
export async function claimDelivery(
  source: string,
  externalId: string | null,
  eventType: string,
  payload: unknown,
): Promise<ClaimResult> {
  if (externalId === null) return "claimed";

  const [row] = await db
    .insert(syncLog)
    .values({ source, eventType, externalId, payload, status: "processing" })
    .onConflictDoUpdate({
      target: [syncLog.source, syncLog.externalId],
      set: { eventType, payload, status: "processing", processedAt: new Date() },
      setWhere: eq(syncLog.status, "failed"),
    })
    .returning({ id: syncLog.id });

  return row ? "claimed" : "duplicate";
}

/** Finalizes a claimed delivery's outcome. Only ever called after a
 * successful claimDelivery, so this is a plain UPDATE — the row is
 * guaranteed to already exist (or, for externalId === null, there was never
 * a claim row to begin with, so this inserts a fresh log entry instead). */
export async function recordDeliveryOutcome(
  source: string,
  eventType: string,
  externalId: string | null,
  payload: unknown,
  status: "processed" | "failed",
) {
  if (externalId === null) {
    await db.insert(syncLog).values({ source, eventType, externalId, payload, status });
    return;
  }

  await db
    .update(syncLog)
    .set({ eventType, payload, status, processedAt: new Date() })
    .where(and(eq(syncLog.source, source), eq(syncLog.externalId, externalId)));
}

// Kept as a read-only convenience for anything that just wants to check
// terminal state without claiming (e.g. debugging/admin tooling) — not used
// by the webhook routes themselves anymore, which use claimDelivery instead.
export async function wasAlreadyProcessed(source: string, externalId: string | null): Promise<boolean> {
  if (externalId === null) return false;
  const [row] = await db
    .select({ id: syncLog.id })
    .from(syncLog)
    .where(and(eq(syncLog.source, source), eq(syncLog.externalId, externalId), eq(syncLog.status, "processed")))
    .limit(1);
  return row !== undefined;
}
