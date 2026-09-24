import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getCampaignSendByTrackingToken: vi.fn().mockResolvedValue(null),
  recordEvent: vi.fn(),
}));
vi.mock("@carnival/db", () => dbMock);

const { buildApp } = await import("../src/app.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rate limiting", () => {
  it("throttles a public route (tracking pixel) after too many requests from the same client", async () => {
    const app = await buildApp();

    let sawTooManyRequests = false;
    for (let i = 0; i < 310; i++) {
      const res = await app.inject({ method: "GET", url: "/t/o/sometoken" });
      if (res.statusCode === 429) {
        sawTooManyRequests = true;
        break;
      }
    }

    expect(sawTooManyRequests).toBe(true);
  });

  it("does not throttle the WooCommerce webhook route, even under a burst", async () => {
    const app = await buildApp();

    const statuses: number[] = [];
    for (let i = 0; i < 310; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/woocommerce",
        headers: {
          "content-type": "application/json",
          "x-wc-webhook-signature": "irrelevant-will-fail-signature-check",
        },
        payload: "{}",
      });
      statuses.push(res.statusCode);
    }

    // Every request should fail signature verification (401), never 429 —
    // proving this route is exempt from the app-wide rate limit.
    expect(new Set(statuses)).toEqual(new Set([401]));
  });
});
