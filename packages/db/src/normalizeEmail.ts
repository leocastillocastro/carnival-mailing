/** Applied before every email is stored or looked up, so `Jane@Example.com`
 * and `jane@example.com` always resolve to the same contact, the same
 * suppression row, and the same admin user — instead of the unique index
 * (which is case-sensitive) silently treating them as different people. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
