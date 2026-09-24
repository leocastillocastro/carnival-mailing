import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the X-WC-Webhook-Signature header: WooCommerce computes it as
 * base64(HMAC-SHA256(rawBody, webhookSecret)). Must run against the raw,
 * unparsed request body — signing depends on exact byte content.
 */
export function verifyWooSignature(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
