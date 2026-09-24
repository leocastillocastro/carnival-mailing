import { createVerify, X509Certificate, type KeyLike } from "node:crypto";
import { isTrustedSnsHost } from "./snsHostGuard.js";

export interface SnsSignedEnvelope {
  Type: string;
  MessageId: string;
  Message: string;
  Subject?: string;
  Timestamp: string;
  TopicArn: string;
  SubscribeURL?: string;
  Token?: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

// Exact field lists/order from AWS's spec — deviating in any way (missing
// field, wrong order, extra space) produces a different string and the
// signature will never verify. https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html
const NOTIFICATION_FIELDS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_FIELDS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

/** `Subject` is the only optional field in either list — every other field is
 * required for the message type it applies to. */
export function buildStringToSign(envelope: SnsSignedEnvelope): string {
  const fields = envelope.Type === "Notification" ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
  const values = envelope as unknown as Record<string, string | undefined>;
  let result = "";
  for (const field of fields) {
    const value = values[field];
    if (value === undefined) {
      if (field === "Subject") continue;
      throw new Error(`SNS envelope is missing required field for signing: ${field}`);
    }
    result += `${field}\n${value}\n`;
  }
  return result;
}

export function verifySignatureWithKey(
  stringToSign: string,
  signatureBase64: string,
  publicKey: KeyLike,
  signatureVersion: string,
): boolean {
  if (signatureVersion !== "1" && signatureVersion !== "2") return false;
  const verifier = createVerify(signatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256");
  verifier.update(stringToSign, "utf8");
  return verifier.verify(publicKey, signatureBase64, "base64");
}

const certCache = new Map<string, string>();

async function fetchSigningCertPem(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  if (!isTrustedSnsHost(url)) {
    throw new Error(`refusing to fetch SNS signing certificate from untrusted host: ${new URL(url).hostname}`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch SNS signing certificate: ${res.status}`);
  }
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

/** The only real proof a webhook call came from SNS, not just from someone who
 * found the URL token — verifies the RSA signature AWS attaches to every
 * message against the cert it points to. Never throws: any failure (untrusted
 * cert host, fetch error, bad signature) collapses to `false` so the caller can
 * treat it uniformly as "not authenticated". */
export async function verifySnsSignature(envelope: SnsSignedEnvelope): Promise<boolean> {
  try {
    const pem = await fetchSigningCertPem(envelope.SigningCertURL);
    const publicKey = new X509Certificate(pem).publicKey;
    const stringToSign = buildStringToSign(envelope);
    return verifySignatureWithKey(stringToSign, envelope.Signature, publicKey, envelope.SignatureVersion);
  } catch {
    return false;
  }
}
