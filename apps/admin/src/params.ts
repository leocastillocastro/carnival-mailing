/** Parses a route `:id` param as a positive integer, or returns null for
 * anything else (non-numeric, negative, decimal). Without this, `Number("abc")`
 * is `NaN`, which used to reach the DB layer directly and produce a raw
 * driver-level 500 instead of a clean 404. */
export function parseIdParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}
