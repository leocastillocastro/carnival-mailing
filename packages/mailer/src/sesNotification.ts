export interface SesRecipient {
  emailAddress: string;
}

export interface SesBounceNotification {
  notificationType: "Bounce";
  bounce: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bounceSubType: string;
    bouncedRecipients: SesRecipient[];
  };
  mail: { messageId: string };
}

export interface SesComplaintNotification {
  notificationType: "Complaint";
  complaint: {
    complainedRecipients: SesRecipient[];
  };
  mail: { messageId: string };
}

export interface SesDeliveryNotification {
  notificationType: "Delivery";
  mail: { messageId: string };
}

export type SesNotification = SesBounceNotification | SesComplaintNotification | SesDeliveryNotification;

const KNOWN_NOTIFICATION_TYPES = new Set(["Bounce", "Complaint", "Delivery"]);

// SES sends this once through the topic the moment you point an identity's
// Bounce/Complaint notifications at it (Identities > Notifications > Edit),
// to confirm the wiring — it has no `mail`/`bounce`/`complaint` payload, so
// it can't be parsed as a SesNotification and there's nothing to act on.
// AmazonSnsSubscriptionFailed is its documented failure counterpart.
const ADMINISTRATIVE_NOTIFICATION_TYPES = new Set(["AmazonSnsSubscriptionSucceeded", "AmazonSnsSubscriptionFailed"]);

/** Parses the inner `Message` field of an SNS Notification envelope — that field
 * is itself a JSON string holding SES's own event shape (bounce/complaint/delivery).
 * Returns null for a recognized administrative message that isn't one of those. */
export function parseSesNotification(message: string): SesNotification | null {
  const parsed = JSON.parse(message);
  if (ADMINISTRATIVE_NOTIFICATION_TYPES.has(parsed?.notificationType)) {
    return null;
  }
  if (!KNOWN_NOTIFICATION_TYPES.has(parsed?.notificationType)) {
    throw new Error(`unknown SES notification type: ${parsed?.notificationType}`);
  }
  return parsed as SesNotification;
}
