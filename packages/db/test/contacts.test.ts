import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import {
  findContactByEmail,
  getDistinctAttributeValues,
  getSubscribedContactCount,
  upsertContactFromWoo,
} from "../src/repositories/contacts.js";
import { contacts } from "../src/schema.js";

const email = "audit-test-duplicate@example.com";

afterEach(async () => {
  await db.delete(contacts).where(eq(contacts.email, email));
});

describe("upsertContactFromWoo", () => {
  it("throws instead of silently inserting an empty email", async () => {
    await expect(upsertContactFromWoo({ email: "", wooCustomerId: 1 })).rejects.toThrow(/email is required/);
  });

  it("updates the same row when the same wooCustomerId is seen again", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10 });
    await upsertContactFromWoo({ email, firstName: "Ana Maria", wooCustomerId: 10 });

    const row = await findContactByEmail(email);
    expect(row?.firstName).toBe("Ana Maria");
  });

  it("does not crash with a unique-violation when a different wooCustomerId later claims the same email (merged/duplicate WooCommerce account)", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10 });

    await expect(upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 20 })).resolves.not.toThrow();

    const row = await findContactByEmail(email);
    expect(row?.wooCustomerId).toBe(20);
  });

  it("stores attributes passed on insert", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { city: "Barcelona" } });

    const row = await findContactByEmail(email);
    expect(row?.attributes).toEqual({ city: "Barcelona" });
  });

  it("merges new attributes into existing ones instead of replacing them", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { city: "Barcelona" } });
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { phone: "600111222" } });

    const row = await findContactByEmail(email);
    expect(row?.attributes).toEqual({ city: "Barcelona", phone: "600111222" });
  });

  it("does not wipe a previously known city when a later sync has no billing city at all", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { city: "Barcelona" } });
    // Same shape mapWooCustomerToContact returns when a payload has no billing city.
    await upsertContactFromWoo({ email, firstName: "Ana Maria", wooCustomerId: 10, attributes: {} });

    const row = await findContactByEmail(email);
    expect(row?.attributes).toEqual({ city: "Barcelona" });
    expect(row?.firstName).toBe("Ana Maria");
  });

  it("clears a previously known city when a later sync explicitly reports it blank (attributes.city: null)", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { city: "Barcelona" } });
    // Same shape mapWooCustomerToContact returns when billing IS present but
    // its city is blank — distinct from the test above, where billing was
    // absent entirely and nothing should change.
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { city: null } });

    const row = await findContactByEmail(email);
    expect(row?.attributes).toEqual({ city: null });
  });

  it("treats different casing of the same email as the same contact", async () => {
    const mixedCase = "Audit-Test-Duplicate@Example.com";
    await upsertContactFromWoo({ email: mixedCase, firstName: "Ana", wooCustomerId: 10 });

    // Second call uses a different casing entirely — should update the same
    // row (via the email unique index), not create a second contact.
    await upsertContactFromWoo({ email: email.toUpperCase(), firstName: "Ana Maria", wooCustomerId: 10 });

    const byLowercase = await findContactByEmail(email);
    const byMixedCase = await findContactByEmail(mixedCase);
    expect(byLowercase?.id).toBe(byMixedCase?.id);
    expect(byLowercase?.firstName).toBe("Ana Maria");
    expect(byLowercase?.email).toBe(email);
  });
});

describe("getDistinctAttributeValues", () => {
  // Uses a made-up attribute key so this can't collide with real data already
  // sitting in this same (shared, non-test-only) database.
  it("returns the distinct non-null values stored under the given key", async () => {
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { testMarkerField: "Zaragoza" } });

    const values = await getDistinctAttributeValues("testMarkerField");

    expect(values).toContain("Zaragoza");
  });

  it("returns an empty array when nothing has that attribute key", async () => {
    const values = await getDistinctAttributeValues("thisKeyDefinitelyDoesNotExistAnywhere");
    expect(values).toEqual([]);
  });
});

describe("getSubscribedContactCount", () => {
  // This database is shared (real, non-isolated data alongside test rows),
  // so the count itself can't be asserted directly — only that adding one
  // subscribed contact moves it by exactly one, and an internal-tagged one
  // (the shop's own accounts — see @carnival/segments' compileSegmentWhere,
  // which excludes them from every segment the same way) doesn't move it at all.
  it("counts a newly subscribed contact", async () => {
    const before = await getSubscribedContactCount();
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10 });
    expect(await getSubscribedContactCount()).toBe(before + 1);
  });

  it("excludes a contact tagged attributes.internal = 'true'", async () => {
    const before = await getSubscribedContactCount();
    await upsertContactFromWoo({ email, firstName: "Ana", wooCustomerId: 10, attributes: { internal: "true" } });
    expect(await getSubscribedContactCount()).toBe(before);
  });
});
