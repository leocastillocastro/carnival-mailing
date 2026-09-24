// Shared by SubscribeURL confirmation and SigningCertURL fetch — both are
// URLs SNS puts in the message that we then GET, so both need the same
// anti-SSRF guard: refuse anything that isn't genuinely AWS-hosted.
const ALLOWED_SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

export function isTrustedSnsHost(url: string): boolean {
  try {
    return ALLOWED_SNS_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
