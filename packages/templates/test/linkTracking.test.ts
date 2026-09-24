import { describe, expect, it } from "vitest";
import { injectTrackingPixel, rewriteLinksForTracking } from "../src/linkTracking.js";

const buildClickUrl = (url: string) => `https://track.example.com/t/c/tok?u=${encodeURIComponent(url)}`;

describe("rewriteLinksForTracking", () => {
  it("rewrites an absolute http(s) link to a click-tracking redirect", () => {
    const html = rewriteLinksForTracking('<a href="https://example.com/oferta">Ver oferta</a>', {
      buildClickUrl,
    });
    expect(html).toBe(
      '<a href="https://track.example.com/t/c/tok?u=https%3A%2F%2Fexample.com%2Foferta">Ver oferta</a>',
    );
  });

  it("leaves mailto: links untouched", () => {
    const html = rewriteLinksForTracking('<a href="mailto:hola@example.com">Escribinos</a>', {
      buildClickUrl,
    });
    expect(html).toBe('<a href="mailto:hola@example.com">Escribinos</a>');
  });

  it("leaves relative links and in-page anchors untouched", () => {
    const html = rewriteLinksForTracking('<a href="#top">Subir</a><a href="/relativo">Rel</a>', { buildClickUrl });
    expect(html).toBe('<a href="#top">Subir</a><a href="/relativo">Rel</a>');
  });

  it("never rewrites a URL in skipUrls (the unsubscribe link)", () => {
    const unsubscribeUrl = "https://track.example.com/unsubscribe/tok";
    const html = rewriteLinksForTracking(`<a href="${unsubscribeUrl}">Baja</a>`, {
      buildClickUrl,
      skipUrls: [unsubscribeUrl],
    });
    expect(html).toBe(`<a href="${unsubscribeUrl}">Baja</a>`);
  });

  it("decodes &amp; before treating href as a URL, so multi-parameter query strings survive", () => {
    // The standards-correct way to write a two-parameter link inside an HTML
    // attribute — most editors/CMSs output exactly this. Without decoding
    // first, the literal "&amp;" text gets percent-encoded as part of the
    // URL itself, and the final redirect (a plain HTTP Location header, not
    // HTML) splits on that leftover literal "&", losing "sort=asc" as its
    // own parameter instead of decoding back to the real destination.
    const html = rewriteLinksForTracking('<a href="https://example.com/tienda?cat=1&amp;sort=asc">Tienda</a>', {
      buildClickUrl,
    });
    expect(html).toContain(encodeURIComponent("https://example.com/tienda?cat=1&sort=asc"));
    expect(html).not.toContain("amp%3B");
  });

  it("leaves a raw, unescaped & in an href untouched (still a valid destination)", () => {
    const html = rewriteLinksForTracking('<a href="https://example.com/tienda?cat=1&sort=asc">Tienda</a>', {
      buildClickUrl,
    });
    expect(html).toContain(encodeURIComponent("https://example.com/tienda?cat=1&sort=asc"));
  });

  it("rewrites multiple links independently", () => {
    const html = rewriteLinksForTracking(
      '<a href="https://a.example.com">A</a><a href="https://b.example.com">B</a>',
      { buildClickUrl },
    );
    expect(html).toContain(encodeURIComponent("https://a.example.com"));
    expect(html).toContain(encodeURIComponent("https://b.example.com"));
  });
});

describe("injectTrackingPixel", () => {
  it("inserts the pixel right before </body>", () => {
    const html = injectTrackingPixel("<html><body><p>hola</p></body></html>", "https://track.example.com/t/o/tok");
    expect(html).toBe(
      '<html><body><p>hola</p><img src="https://track.example.com/t/o/tok" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" /></body></html>',
    );
  });

  it("appends the pixel when there is no </body> tag (fragment templates)", () => {
    const html = injectTrackingPixel("<p>hola</p>", "https://track.example.com/t/o/tok");
    expect(html).toBe(
      '<p>hola</p><img src="https://track.example.com/t/o/tok" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />',
    );
  });
});
