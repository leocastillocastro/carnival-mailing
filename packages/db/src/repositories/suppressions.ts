import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { normalizeEmail } from "../normalizeEmail.js";
import { suppressions } from "../schema.js";

export type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "manual";

export async function addSuppression(email: string, reason: SuppressionReason, source?: string) {
  const [row] = await db
    .insert(suppressions)
    .values({ email: normalizeEmail(email), reason, source })
    .onConflictDoNothing({ target: suppressions.email })
    .returning();
  return row ?? null;
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, normalizeEmail(email)))
    .limit(1);
  return row !== undefined;
}

/** Used by the resubscribe undo path. `email` has a single-row unique index (not
 * email+reason), so a contact can only ever have one suppression row at a time —
 * if they were already suppressed for `bounce`/`complaint`, a later `unsubscribe`
 * never overwrote it (addSuppression's onConflictDoNothing is a no-op). Scoping
 * the delete to `reason` means resubscribe only ever removes a row it could have
 * plausibly created itself, never silently lifting a bounce/complaint suppression
 * that was there the whole time under the same email. */
export async function removeSuppression(email: string, reason: SuppressionReason) {
  await db.delete(suppressions).where(and(eq(suppressions.email, normalizeEmail(email)), eq(suppressions.reason, reason)));
}
