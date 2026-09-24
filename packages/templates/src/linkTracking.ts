const ANCHOR_TAG_RE = /<a\b[^>]*>/gi;
const HREF_ATTR_RE = /href\s*=\s*(["'])(.*?)\1/i;
const BODY_CLOSE_RE = /<\/body\s*>/i;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the handful of HTML entities that legitimately show up inside an
 * href attribute. Multi-parameter query strings are correctly written as
 * `?a=1&amp;b=2` in HTML source — without decoding that back to a real `&`
 * first, the literal 5 characters "&amp;" get treated as part of the URL
 * itself, and everything after the second parameter is lost once the final
 * redirect (a plain HTTP Location header, not HTML) splits the query string
 * on the literal `&` that "amp;" left behind. */
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, ref: string) => {
    if (ref[0] === "#") {
      const codePoint = ref[1]?.toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isNaN(codePoint) ? entity : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? entity;
  });
}

export interface RewriteLinksOptions {
  buildClickUrl: (targetUrl: string) => string;
  /** Exact hrefs to leave untouched — the unsubscribe link, per Listmonk/Mautic
   * both treating it as a dedicated system tag that never runs through the
   * generic click-rewrite pass. */
  skipUrls?: string[];
}

/** Rewrites every absolute http(s) <a href> to a click-tracking redirect.
 * Relative links, in-page anchors, mailto:/tel: and skipUrls are left as-is. */
export function rewriteLinksForTracking(html: string, opts: RewriteLinksOptions): string {
  const skip = new Set(opts.skipUrls ?? []);
  return html.replace(ANCHOR_TAG_RE, (tag) => {
    const match = HREF_ATTR_RE.exec(tag);
    if (!match) return tag;
    const [full, quote, rawHref] = match;
    const href = decodeHtmlEntities(rawHref);
    if (!/^https?:\/\//i.test(href) || skip.has(href)) return tag;
    return tag.replace(full, `href=${quote}${opts.buildClickUrl(href)}${quote}`);
  });
}

/** Inserts the open-tracking pixel before </body>, or appends it if the
 * template has no body tag (fragment templates). */
export function injectTrackingPixel(html: string, pixelUrl: string): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  if (BODY_CLOSE_RE.test(html)) {
    return html.replace(BODY_CLOSE_RE, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}
