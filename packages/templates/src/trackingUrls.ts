export interface TrackingUrls {
  pixelUrl: string;
  unsubscribeUrl: string;
  buildClickUrl: (targetUrl: string) => string;
}

/** trackingToken is campaignSends.trackingToken — the only recipient identifier
 * ever placed in these URLs, never a raw contact id or email. */
export function buildTrackingUrls(baseUrl: string, trackingToken: string): TrackingUrls {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    pixelUrl: `${base}/t/o/${trackingToken}`,
    unsubscribeUrl: `${base}/unsubscribe/${trackingToken}`,
    buildClickUrl: (targetUrl: string) => `${base}/t/c/${trackingToken}?u=${encodeURIComponent(targetUrl)}`,
  };
}
