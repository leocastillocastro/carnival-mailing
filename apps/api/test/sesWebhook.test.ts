import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  recordDeliveryOutcome: vi.fn(),
  claimDelivery: vi.fn().mockResolvedValue("claimed"),
  addSuppression: vi.fn(),
  findContactByEmail: vi.fn().mockResolvedValue(null),
  markContactStatus: vi.fn(),
  markCampaignSendBounced: vi.fn(),
  markCampaignSendComplained: vi.fn(),
  getCampaignSendByProviderMessageId: vi.fn().mockResolvedValue(null),
  recordEvent: vi.fn(),
}));
vi.mock("@carnival/db", () => db);

// The actual RSA/X.509 mechanics of verifySnsSignature are covered by
// packages/mailer's own tests — these route tests only care about how the
// route reacts to a valid vs. invalid verdict, so it's mocked here rather
// than constructing real signed envelopes for every case.
const mailer = vi.hoisted(() => ({ verifySnsSignature: vi.fn().mockResolvedValue(true) }));
vi.mock("@carnival/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/mailer")>()),
  ...mailer,
}));

const { buildApp } = await import("../src/app.js");

const token = process.env.SES_WEBHOOK_TOKEN!;
const topicArn = process.env.SES_SNS_TOPIC_ARN!;
const validSubscribeUrl = "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc";

function post(app: FastifyInstance, path: string, envelope: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "text/plain" },
    payload: JSON.stringify({ TopicArn: topicArn, ...envelope }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mailer.verifySnsSignature.mockResolvedValue(true);
  db.claimDelivery.mockResolvedValue("claimed");
  db.findContactByEmail.mockResolvedValue(null);
  db.getCampaignSendByProviderMessageId.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /webhooks/ses/:token", () => {
  it("rejects an invalid token without touching the database", async () => {
    const app = await buildApp();
    const res = await post(app, "/webhooks/ses/wrong-token", { Type: "Notification", MessageId: "m1", Message: "{}" });

    expect(res.statusCode).toBe(401);
    expect(db.claimDelivery).not.toHaveBeenCalled();
  });

  it("rejects a message signed for the wrong TopicArn, even with a valid token and signature", async () => {
    const app = await buildApp();
    const res = await post(app, `/webhooks/ses/${token}`, {
      TopicArn: "arn:aws:sns:eu-west-1:999999999999:someone-elses-topic",
      Type: "Notification",
      MessageId: "wrong-topic",
      Message: "{}",
    });

    expect(res.statusCode).toBe(401);
    expect(db.claimDelivery).not.toHaveBeenCalled();
  });

  it("rejects a message that fails SNS signature verification", async () => {
    mailer.verifySnsSignature.mockResolvedValue(false);
    const app = await buildApp();
    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "bad-sig", Message: "{}" });

    expect(res.statusCode).toBe(401);
    expect(db.claimDelivery).not.toHaveBeenCalled();
  });

  it("returns 'duplicate' for a MessageId already processed, without running any bounce logic", async () => {
    db.claimDelivery.mockResolvedValue("duplicate");
    const app = await buildApp();

    const res = await post(app, `/webhooks/ses/${token}`, {
      Type: "Notification",
      MessageId: "dup-1",
      Message: JSON.stringify({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "x@example.com" }] }, mail: { messageId: "ses-1" } }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "duplicate" });
    expect(db.addSuppression).not.toHaveBeenCalled();
  });

  it("confirms a SubscriptionConfirmation by fetching the trusted SubscribeURL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp();

    const res = await post(app, `/webhooks/ses/${token}`, {
      Type: "SubscriptionConfirmation",
      MessageId: "sub-1",
      SubscribeURL: validSubscribeUrl,
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(validSubscribeUrl);
    expect(db.recordDeliveryOutcome).toHaveBeenCalledWith("ses", "SubscriptionConfirmation", "sub-1", expect.anything(), "processed");
  });

  it("refuses to confirm a subscription at an untrusted host (SSRF guard) and never fetches it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp();

    const res = await post(app, `/webhooks/ses/${token}`, {
      Type: "SubscriptionConfirmation",
      MessageId: "sub-2",
      SubscribeURL: "https://evil.example.com/confirm",
    });

    expect(res.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.recordDeliveryOutcome).toHaveBeenCalledWith("ses", "SubscriptionConfirmation", "sub-2", expect.anything(), "failed");
  });

  it("suppresses, marks the contact bounced, and marks the campaign_send bounced on a permanent bounce", async () => {
    db.findContactByEmail.mockResolvedValue({ id: 7, email: "rebota@example.com" });
    db.getCampaignSendByProviderMessageId.mockResolvedValue({ id: 55, campaignId: 3 });
    const app = await buildApp();

    const message = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "rebota@example.com" }] },
      mail: { messageId: "ses-msg-1" },
    });

    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "n1", Message: message });

    expect(res.statusCode).toBe(200);
    expect(db.addSuppression).toHaveBeenCalledWith("rebota@example.com", "bounce", "ses-sns");
    expect(db.markContactStatus).toHaveBeenCalledWith(7, "bounced");
    expect(db.markCampaignSendBounced).toHaveBeenCalledWith(55, "Permanent/General");
    expect(db.recordEvent).toHaveBeenCalledWith({ contactId: 7, campaignId: 3, sendId: 55, type: "bounce" });
  });

  it("does not suppress on a transient bounce, but still records the event", async () => {
    db.findContactByEmail.mockResolvedValue({ id: 8, email: "temporal@example.com" });
    const app = await buildApp();

    const message = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "temporal@example.com" }] },
      mail: { messageId: "ses-msg-2" },
    });

    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "n2", Message: message });

    expect(res.statusCode).toBe(200);
    expect(db.addSuppression).not.toHaveBeenCalled();
    expect(db.markContactStatus).not.toHaveBeenCalled();
    expect(db.markCampaignSendBounced).not.toHaveBeenCalled();
    expect(db.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ contactId: 8, type: "bounce" }));
  });

  it("always suppresses on a spam complaint", async () => {
    db.findContactByEmail.mockResolvedValue({ id: 9, email: "quejoso@example.com" });
    const app = await buildApp();

    const message = JSON.stringify({
      notificationType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "quejoso@example.com" }] },
      mail: { messageId: "ses-msg-3" },
    });

    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "n3", Message: message });

    expect(res.statusCode).toBe(200);
    expect(db.addSuppression).toHaveBeenCalledWith("quejoso@example.com", "complaint", "ses-sns");
    expect(db.markContactStatus).toHaveBeenCalledWith(9, "complained");
  });

  it("moves the campaign_send's own status to 'complained', not left as 'sent' forever", async () => {
    db.findContactByEmail.mockResolvedValue({ id: 9, email: "quejoso@example.com" });
    db.getCampaignSendByProviderMessageId.mockResolvedValue({ id: 55, campaignId: 7 });
    const app = await buildApp();

    const message = JSON.stringify({
      notificationType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "quejoso@example.com" }] },
      mail: { messageId: "ses-msg-3" },
    });

    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "n3b", Message: message });

    expect(res.statusCode).toBe(200);
    expect(db.markCampaignSendComplained).toHaveBeenCalledWith(55);
  });

  it("ignores Delivery notifications", async () => {
    const app = await buildApp();
    const message = JSON.stringify({ notificationType: "Delivery", mail: { messageId: "ses-msg-4" } });

    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "n4", Message: message });

    expect(res.statusCode).toBe(200);
    expect(db.addSuppression).not.toHaveBeenCalled();
    expect(db.recordEvent).not.toHaveBeenCalled();
  });

  it("returns 200 (not 500) for the AmazonSnsSubscriptionSucceeded confirmation SES sends when wiring up identity notifications", async () => {
    const app = await buildApp();
    const message = JSON.stringify({ notificationType: "AmazonSnsSubscriptionSucceeded" });

    const res = await post(app, `/webhooks/ses/${token}`, { Type: "Notification", MessageId: "n5", Message: message });

    expect(res.statusCode).toBe(200);
    expect(db.recordDeliveryOutcome).toHaveBeenCalledWith("ses", "Notification", "n5", expect.anything(), "processed");
  });
});
