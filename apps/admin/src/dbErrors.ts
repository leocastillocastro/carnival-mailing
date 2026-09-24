const FOREIGN_KEY_VIOLATION = "23503";

/** True for a Postgres foreign-key-violation error (SQLSTATE 23503) — the
 * `pg` driver attaches the SQLSTATE code as `.code` on the thrown error.
 * campaigns.templateId/listId/segmentId have no `onDelete` behavior (default
 * `NO ACTION`), so deleting any of those while a campaign — even a long-sent
 * one — still references it throws exactly this, uncaught, as a raw 500. */
export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === FOREIGN_KEY_VIOLATION;
}
