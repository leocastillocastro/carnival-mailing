import {
  claimCampaignSendForSending,
  getCampaignSendDetail,
  isEmailSuppressed,
  markCampaignSendFailed,
  markCampaignSendSent,
  markCampaignSendSuppressed,
  revertCampaignSendToQueued,
} from "@carnival/db";
import { sendEmail, sesDefinitelyRejected } from "@carnival/mailer";
import { personalizeTemplate } from "@carnival/templates";
import { env } from "./env.js";

export interface ProcessResult {
  skipped: boolean;
  reason?: string;
  messageId?: string;
}

export async function processCampaignSend(campaignSendId: number): Promise<ProcessResult> {
  const detail = await getCampaignSendDetail(campaignSendId);
  if (!detail) {
    throw new Error(`campaign_send ${campaignSendId} not found`);
  }

  if (detail.status === "sent" || detail.status === "suppressed") {
    return { skipped: true, reason: `already ${detail.status}` };
  }

  if (await isEmailSuppressed(detail.contactEmail)) {
    await markCampaignSendSuppressed(campaignSendId);
    return { skipped: true, reason: "suppressed" };
  }

  // SES gives no idempotency/dedup token for SendEmail, so this atomic
  // queued->sending claim is the only thing standing between us and a
  // duplicate send. Every *handled* failure below reverts back to `queued`
  // before returning, so failing to claim here (row already at `sending`)
  // can only mean a previous attempt's process died mid-flight — we have no
  // way to know whether its SES call actually landed. Resending risks a
  // duplicate email to a real customer; refusing to and requiring a human to
  // check SES/CloudWatch before manually resending is the safer default.
  if (!(await claimCampaignSendForSending(campaignSendId))) {
    await markCampaignSendFailed(
      campaignSendId,
      "worker crashed or lost its lock mid-send on a previous attempt — outcome unknown, verify manually before resending",
    );
    return { skipped: true, reason: "ambiguous previous attempt" };
  }

  let html: string;
  let unsubscribeUrl: string;
  try {
    // A broken/edited template (assertNoRawOutput tripping, a link-rewriting
    // bug) throwing here is unambiguous — it never got anywhere near SES, so
    // it always gets the same revert-and-rethrow treatment as a definite SES
    // rejection below, never the "ambiguous, don't auto-retry" one. Kept in
    // its own try/catch, separate from the SES call, specifically so a
    // template error can never be misread as a network-level SES ambiguity
    // (see sesDefinitelyRejected below) just because it also lacks AWS SDK
    // error metadata.
    ({ html, unsubscribeUrl } = personalizeTemplate({
      html: detail.templateHtml,
      contact: {
        firstName: detail.contactFirstName,
        lastName: detail.contactLastName,
        email: detail.contactEmail,
        attributes: detail.contactAttributes,
      },
      baseUrl: env.APP_BASE_URL,
      trackingToken: detail.trackingToken,
      campaign: detail.campaignContentFields,
    }));
  } catch (err) {
    await revertCampaignSendToQueued(campaignSendId);
    throw err;
  }

  let messageId: string;
  try {
    ({ messageId } = await sendEmail({
      to: detail.contactEmail,
      fromEmail: detail.fromEmail,
      fromName: detail.fromName,
      subject: detail.subject,
      html,
      // RFC 8058 one-click unsubscribe — required by Gmail/Yahoo for bulk senders.
      // The mailto fallback is for clients that don't support the header at all.
      headers: [
        { name: "List-Unsubscribe", value: `<${unsubscribeUrl}>, <mailto:${detail.fromEmail}?subject=unsubscribe>` },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    }));
  } catch (err) {
    if (sesDefinitelyRejected(err)) {
      // SES itself answered (even with an error) — the request definitely
      // never went through this attempt, safe to hand back a clean,
      // claimable `queued` row.
      await revertCampaignSendToQueued(campaignSendId);
      throw err;
    }
    // A network-level failure (timeout, connection reset) with no response
    // at all from SES — unlike the case above, SES may have already accepted
    // and queued the email before the response was lost. Retrying risks a
    // real duplicate to a real customer, so this gets the same conservative
    // "stop and let a human verify" treatment as the crash-recovery case
    // above, instead of an automatic BullMQ retry.
    await markCampaignSendFailed(
      campaignSendId,
      `send outcome unknown after a network-level error — verify manually before resending: ${(err as Error).message}`,
    );
    return { skipped: true, reason: "ambiguous send outcome" };
  }

  await markCampaignSendSent(campaignSendId, messageId);
  return { skipped: false, messageId };
}
