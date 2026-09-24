import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { personalizeTemplate } from "../src/personalize.js";
import { extractCampaignFieldNames } from "../src/render.js";

// Point-in-time snapshots of the real templates saved in production (see
// scripts/dumpTemplates.ts in apps/admin), refreshed manually — not a live DB
// read, so this suite never depends on prod being reachable. Every other test
// in this package renders synthetic minimal HTML, which would miss a
// regression that only shows up against the real markup (fixed table widths,
// the real CTA/footer structure). Each template's {{campaign.*}} fields (the
// promo title, price, photo...) are filled with dummy values purely so the
// pipeline can be exercised — this suite checks tracking/unsubscribe
// survival, not whether the real campaign copy is any good.
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const contact = { firstName: "María", lastName: "García", email: "maria@example.com", attributes: {} };

describe("real production templates", () => {
  for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".html"))) {
    it(`${file}: keeps the tracking pixel, click-tracking links, and unsubscribe link intact`, () => {
      const html = readFileSync(path.join(fixturesDir, file), "utf-8");
      const campaign = Object.fromEntries(extractCampaignFieldNames(html).map((field) => [field, `${field} de ejemplo`]));

      const rawHttpLinks = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].filter(
        (m) => !m[1].includes("{{unsubscribeUrl}}"),
      );

      const { html: rendered, unsubscribeUrl } = personalizeTemplate({
        html,
        contact,
        campaign,
        baseUrl: "https://track.example.com",
        trackingToken: "tok-smoke-test",
      });

      expect(rendered).toContain('<img src="https://track.example.com/t/o/tok-smoke-test"');
      expect(unsubscribeUrl).toBe("https://track.example.com/unsubscribe/tok-smoke-test");
      expect(rendered).toContain(`href="${unsubscribeUrl}"`);

      for (const [, originalUrl] of rawHttpLinks) {
        expect(rendered).toContain(`u=${encodeURIComponent(originalUrl)}`);
      }
    });
  }
});
