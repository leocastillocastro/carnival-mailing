import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { claimDelivery, recordDeliveryOutcome } from "../src/repositories/syncLog.js";
import { syncLog } from "../src/schema.js";

const source = "audit-test";
const externalId = "delivery-race-1";

afterEach(async () => {
  await db.delete(syncLog).where(and(eq(syncLog.source, source), eq(syncLog.externalId, externalId)));
});

describe("claimDelivery", () => {
  it("always claims a delivery with no externalId — can't dedupe without an id", async () => {
    expect(await claimDelivery(source, null, "order.updated", {})).toBe("claimed");
    expect(await claimDelivery(source, null, "order.updated", {})).toBe("claimed");
  });

  it("claims a brand-new delivery id", async () => {
    expect(await claimDelivery(source, externalId, "order.updated", { some: "payload" })).toBe("claimed");
  });

  it("reports a duplicate for a delivery id that's already claimed (in-flight or done)", async () => {
    await claimDelivery(source, externalId, "order.updated", { some: "payload" });
    expect(await claimDelivery(source, externalId, "order.updated", { some: "payload" })).toBe("duplicate");
  });

  it("does not treat a previously-failed delivery as claimed forever — a retry can reclaim it", async () => {
    await claimDelivery(source, externalId, "order.updated", { some: "payload" });
    await recordDeliveryOutcome(source, "order.updated", externalId, { some: "payload" }, "failed");

    expect(await claimDelivery(source, externalId, "order.updated", { some: "payload" })).toBe("claimed");
  });

  it("does not let a second claim through while the first is still processing (not yet recorded as failed)", async () => {
    // Simulates two concurrent deliveries of the same id racing each other —
    // the second claim attempt must lose even though the first hasn't
    // recorded a final outcome yet.
    const first = await claimDelivery(source, externalId, "order.updated", { some: "payload" });
    const second = await claimDelivery(source, externalId, "order.updated", { some: "payload" });

    expect(first).toBe("claimed");
    expect(second).toBe("duplicate");
  });

  it("does not reclaim a delivery that was already recorded as processed", async () => {
    await claimDelivery(source, externalId, "order.updated", { some: "payload" });
    await recordDeliveryOutcome(source, "order.updated", externalId, { some: "payload" }, "processed");

    expect(await claimDelivery(source, externalId, "order.updated", { some: "payload" })).toBe("duplicate");
  });
});
