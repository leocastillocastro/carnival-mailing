import {
  addSuppression,
  findContactByEmail,
  getCampaignSendByProviderMessageId,
  markCampaignSendBounced,
  markCampaignSendComplained,
  markContactStatus,
  recordEvent,
} from "@carnival/db";
import { parseSesNotification } from "@carnival/mailer";

/** Only permanent bounces suppress and mark the send bounced — transient bounces
 * (mailbox full, greylisting) are usually temporary and shouldn't cut a contact
 * off after a single one. They're still recorded as events for visibility.
 * Escalating repeated soft bounces to a suppression isn't implemented yet. */
export async function handleSesNotification(rawMessage: string): Promise<void> {
  const notification = parseSesNotification(rawMessage);
  if (!notification) return;

  if (notification.notificationType === "Delivery") return;

  const send = await getCampaignSendByProviderMessageId(notification.mail.messageId);

  if (notification.notificationType === "Bounce") {
    const { bounce } = notification;
    const isPermanent = bounce.bounceType === "Permanent";

    for (const recipient of bounce.bouncedRecipients) {
      if (isPermanent) {
        await addSuppression(recipient.emailAddress, "bounce", "ses-sns");
      }
      const contact = await findContactByEmail(recipient.emailAddress);
      if (contact) {
        if (isPermanent) await markContactStatus(contact.id, "bounced");
        await recordEvent({ contactId: contact.id, campaignId: send?.campaignId ?? null, sendId: send?.id ?? null, type: "bounce" });
      }
    }

    if (send && isPermanent) {
      await markCampaignSendBounced(send.id, `${bounce.bounceType}/${bounce.bounceSubType}`);
    }
    return;
  }

  // Complaint — always suppress, regardless of any bounce sub-type distinction.
  const { complaint } = notification;
  for (const recipient of complaint.complainedRecipients) {
    await addSuppression(recipient.emailAddress, "complaint", "ses-sns");
    const contact = await findContactByEmail(recipient.emailAddress);
    if (contact) {
      await markContactStatus(contact.id, "complained");
      await recordEvent({ contactId: contact.id, campaignId: send?.campaignId ?? null, sendId: send?.id ?? null, type: "complaint" });
    }
  }

  if (send) {
    await markCampaignSendComplained(send.id);
  }
}
