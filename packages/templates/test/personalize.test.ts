import { describe, expect, it } from "vitest";
import { personalizeTemplate } from "../src/personalize.js";

describe("personalizeTemplate", () => {
  it("renders merge tags, rewrites links, injects the pixel, and skips the unsubscribe link", () => {
    const { html, unsubscribeUrl } = personalizeTemplate({
      html:
        "<html><body><p>Hola {{contact.firstName}}</p>" +
        '<a href="https://example.com/oferta">Ver oferta</a>' +
        '<a href="{{unsubscribeUrl}}">Baja</a></body></html>',
      contact: { firstName: "María", lastName: "García", email: "maria@example.com", attributes: {} },
      baseUrl: "https://track.example.com/",
      trackingToken: "tok123",
    });

    expect(html).toContain("Hola María");
    expect(html).toContain("https://track.example.com/t/c/tok123?u=https%3A%2F%2Fexample.com%2Foferta");
    expect(html).toContain('<a href="https://track.example.com/unsubscribe/tok123">Baja</a>');
    expect(html).toContain('<img src="https://track.example.com/t/o/tok123"');
    expect(unsubscribeUrl).toBe("https://track.example.com/unsubscribe/tok123");
  });
});
