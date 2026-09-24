import { injectTrackingPixel, rewriteLinksForTracking } from "./linkTracking.js";
import { type ContactData, renderTemplate } from "./render.js";
import { buildTrackingUrls } from "./trackingUrls.js";

export interface PersonalizeInput {
  html: string;
  contact: ContactData;
  /** Public base URL of apps/api, e.g. https://track.example.com */
  baseUrl: string;
  trackingToken: string;
  /** Fills the template's {{campaign.*}} tags — see TemplateData. */
  campaign?: Record<string, string>;
}

export interface PersonalizeResult {
  html: string;
  /** Same URL rendered into the template — also needed by the caller to build
   * the List-Unsubscribe email header (RFC 8058 one-click unsubscribe). */
  unsubscribeUrl: string;
}

/** Personalizes a template and wires up open/click tracking, in that order:
 * render merge tags first, then rewrite the resulting links, then inject the
 * pixel — so a merge tag can never itself introduce a link that dodges tracking. */
export function personalizeTemplate(input: PersonalizeInput): PersonalizeResult {
  const { pixelUrl, unsubscribeUrl, buildClickUrl } = buildTrackingUrls(input.baseUrl, input.trackingToken);
  const rendered = renderTemplate(input.html, { contact: input.contact, unsubscribeUrl, campaign: input.campaign });
  const withTrackedLinks = rewriteLinksForTracking(rendered, { buildClickUrl, skipUrls: [unsubscribeUrl] });
  const html = injectTrackingPixel(withTrackedLinks, pixelUrl);
  return { html, unsubscribeUrl };
}
