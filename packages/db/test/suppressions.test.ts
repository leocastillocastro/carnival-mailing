import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { addSuppression, isEmailSuppressed, removeSuppression } from "../src/repositories/suppressions.js";
import { suppressions } from "../src/schema.js";

const testEmail = "audit-test-suppressions@example.com";

afterEach(async () => {
  await db.delete(suppressions).where(eq(suppressions.email, testEmail));
});

describe("suppressions repository", () => {
  it("reports an email as not suppressed when no row exists", async () => {
    expect(await isEmailSuppressed(testEmail)).toBe(false);
  });

  it("reports an email as suppressed once added", async () => {
    await addSuppression(testEmail, "bounce", "ses-notification");
    expect(await isEmailSuppressed(testEmail)).toBe(true);
  });

  it("adding the same email twice is a no-op, not a unique-violation crash", async () => {
    await addSuppression(testEmail, "manual");
    await expect(addSuppression(testEmail, "bounce")).resolves.not.toThrow();
  });

  it("removeSuppression only deletes a row matching the given reason", async () => {
    await addSuppression(testEmail, "bounce", "ses-notification");

    // A later addSuppression for a different reason is a no-op (email is
    // uniquely constrained, not email+reason) — the row is still 'bounce' here.
    await removeSuppression(testEmail, "unsubscribe");
    expect(await isEmailSuppressed(testEmail)).toBe(true);

    await removeSuppression(testEmail, "bounce");
    expect(await isEmailSuppressed(testEmail)).toBe(false);
  });

  it("suppresses and checks case-insensitively — a bounce recorded under one casing still blocks a later send under another", async () => {
    await addSuppression("Audit-Test-Suppressions@Example.com", "bounce", "ses-notification");
    expect(await isEmailSuppressed(testEmail.toUpperCase())).toBe(true);
    expect(await isEmailSuppressed(testEmail)).toBe(true);
  });
});
