import {
  addSuppression,
  getContactByTrackingToken,
  isEmailSuppressed,
  recordEvent,
  removeSuppression,
  resubscribeContact,
  unsubscribeContact,
} from "@carnival/db";

export interface UnsubscribeResult {
  found: boolean;
}

/** Global unsubscribe (contacts.status + suppressions), not per-list — this is
 * a single-list business today; scoping to a list is additive later via
 * contactLists.status, not a rework of this. */
export async function unsubscribeByToken(token: string): Promise<UnsubscribeResult> {
  const contact = await getContactByTrackingToken(token);
  if (!contact) return { found: false };

  await unsubscribeContact(contact.contactId);
  await addSuppression(contact.email, "unsubscribe");
  await recordEvent({
    contactId: contact.contactId,
    campaignId: contact.campaignId,
    sendId: contact.sendId,
    type: "unsubscribe",
  });
  return { found: true };
}

/** Undo path from the confirmation page — only ever removes a suppression the
 * contact created themselves via unsubscribeByToken, never a bounce/complaint one. */
export async function resubscribeByToken(token: string): Promise<UnsubscribeResult> {
  const contact = await getContactByTrackingToken(token);
  if (!contact) return { found: false };

  await removeSuppression(contact.email, "unsubscribe");
  // suppressions.email is uniquely constrained (one row per email, not per
  // reason) — if this contact was already suppressed for bounce/complaint,
  // the earlier unsubscribeByToken's addSuppression was a no-op and the row
  // removed above was never theirs to begin with, so they're still
  // suppressed here. Resetting contacts.status to "subscribed" in that case
  // would show them as subscribed in the admin while a real send still can't
  // reach them — isEmailSuppressed keeps blocking it correctly either way,
  // this is purely about not showing a misleading status.
  if (!(await isEmailSuppressed(contact.email))) {
    await resubscribeContact(contact.contactId);
  }
  return { found: true };
}
