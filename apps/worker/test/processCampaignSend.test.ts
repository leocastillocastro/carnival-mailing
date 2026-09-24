import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getCampaignSendDetail: vi.fn(),
  isEmailSuppressed: vi.fn(),
  claimCampaignSendForSending: vi.fn().mockResolvedValue(true),
  revertCampaignSendToQueued: vi.fn(),
  markCampaignSendFailed: vi.fn(),
  markCampaignSendSent: vi.fn(),
  markCampaignSendSuppressed: vi.fn(),
}));

const mailer = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

const templates = vi.hoisted(() => ({
  personalizeTemplate: vi.fn(),
}));

vi.mock("@carnival/db", () => db);
// sesDefinitelyRejected is a pure function of the error shape — keep the
// real implementation so these tests exercise the actual distinction
// processCampaignSend relies on, instead of a stub that can't tell a real
// SES rejection apart from a network-level failure. Pulling in the real
// module also evaluates sesClient.ts, which eagerly constructs an SESv2Client
// from SES_REGION at import time — a value this test never otherwise needs,
// so it's set here rather than relying on apps/worker/.env being present.
process.env.SES_REGION ??= "eu-west-1";
vi.mock("@carnival/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carnival/mailer")>()),
  ...mailer,
}));
vi.mock("@carnival/templates", () => templates);

const { processCampaignSend } = await import("../src/processCampaignSend.js");

const baseDetail = {
  id: 1,
  status: "queued",
  trackingToken: "tok123",
  contactEmail: "cliente@example.com",
  contactFirstName: "Cliente",
  contactLastName: "Ejemplo",
  contactAttributes: {},
  fromEmail: "newsletter@example.com",
  fromName: "Carnival Meatlab",
  subject: "Hola",
  templateHtml: "<p>Hola</p>",
  campaignContentFields: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  db.claimCampaignSendForSending.mockResolvedValue(true);
  templates.personalizeTemplate.mockReturnValue({
    html: "<p>Hola Cliente</p>",
    unsubscribeUrl: "http://localhost:3000/unsubscribe/tok123",
  });
});

describe("processCampaignSend", () => {
  it("throws if the campaign_send row doesn't exist", async () => {
    db.getCampaignSendDetail.mockResolvedValue(null);
    await expect(processCampaignSend(999)).rejects.toThrow(/not found/);
  });

  it("skips without touching suppressions or SES when already sent", async () => {
    db.getCampaignSendDetail.mockResolvedValue({ ...baseDetail, status: "sent" });
    const result = await processCampaignSend(1);
    expect(result).toEqual({ skipped: true, reason: "already sent" });
    expect(db.isEmailSuppressed).not.toHaveBeenCalled();
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("skips without re-sending when already suppressed", async () => {
    db.getCampaignSendDetail.mockResolvedValue({ ...baseDetail, status: "suppressed" });
    const result = await processCampaignSend(1);
    expect(result).toEqual({ skipped: true, reason: "already suppressed" });
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("checks suppressions before sending and skips if the contact is suppressed", async () => {
    db.getCampaignSendDetail.mockResolvedValue(baseDetail);
    db.isEmailSuppressed.mockResolvedValue(true);

    const result = await processCampaignSend(1);

    expect(db.isEmailSuppressed).toHaveBeenCalledWith("cliente@example.com");
    expect(db.markCampaignSendSuppressed).toHaveBeenCalledWith(1);
    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: "suppressed" });
  });

  it("sends and marks sent when the contact is not suppressed", async () => {
    db.getCampaignSendDetail.mockResolvedValue(baseDetail);
    db.isEmailSuppressed.mockResolvedValue(false);
    mailer.sendEmail.mockResolvedValue({ messageId: "ses-message-id" });

    const result = await processCampaignSend(1);

    expect(db.claimCampaignSendForSending).toHaveBeenCalledWith(1);
    expect(templates.personalizeTemplate).toHaveBeenCalledWith({
      html: "<p>Hola</p>",
      contact: {
        firstName: "Cliente",
        lastName: "Ejemplo",
        email: "cliente@example.com",
        attributes: {},
      },
      baseUrl: expect.any(String),
      trackingToken: "tok123",
      campaign: {},
    });
    expect(mailer.sendEmail).toHaveBeenCalledWith({
      to: "cliente@example.com",
      fromEmail: "newsletter@example.com",
      fromName: "Carnival Meatlab",
      subject: "Hola",
      html: "<p>Hola Cliente</p>",
      headers: [
        {
          name: "List-Unsubscribe",
          value: "<http://localhost:3000/unsubscribe/tok123>, <mailto:newsletter@example.com?subject=unsubscribe>",
        },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    });
    expect(db.markCampaignSendSent).toHaveBeenCalledWith(1, "ses-message-id");
    expect(result).toEqual({ skipped: false, messageId: "ses-message-id" });
  });

  it("passes the campaign's saved content fields through to fill the template's {{campaign.*}} tags", async () => {
    db.getCampaignSendDetail.mockResolvedValue({
      ...baseDetail,
      campaignContentFields: { titulo: "Hamburguesas de ternera", precio: "11,90 € / kg" },
    });
    db.isEmailSuppressed.mockResolvedValue(false);
    mailer.sendEmail.mockResolvedValue({ messageId: "ses-message-id" });

    await processCampaignSend(1);

    expect(templates.personalizeTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ campaign: { titulo: "Hamburguesas de ternera", precio: "11,90 € / kg" } }),
    );
  });

  it("refuses to resend a job stuck at 'sending' from a previous attempt — the claim fails, so it's marked failed instead of calling SES again", async () => {
    // Status is still "sending" in the detail row, but the atomic claim
    // (queued -> sending) is what actually gates a resend — it fails here
    // because there's nothing at "queued" to claim, exactly like a crash that
    // died between claiming and reverting/completing would leave things.
    db.getCampaignSendDetail.mockResolvedValue({ ...baseDetail, status: "sending" });
    db.isEmailSuppressed.mockResolvedValue(false);
    db.claimCampaignSendForSending.mockResolvedValue(false);

    const result = await processCampaignSend(1);

    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(db.markCampaignSendFailed).toHaveBeenCalledWith(1, expect.stringMatching(/verify manually/));
    expect(result).toEqual({ skipped: true, reason: "ambiguous previous attempt" });
  });

  it("propagates a real SES rejection (e.g. throttling) so BullMQ can retry, instead of swallowing it", async () => {
    // A real AWS SDK v3 error carries $metadata.httpStatusCode whenever SES
    // actually answered — that's what marks this as "definitely rejected",
    // safe to revert and let BullMQ retry.
    db.getCampaignSendDetail.mockResolvedValue(baseDetail);
    db.isEmailSuppressed.mockResolvedValue(false);
    const throttlingError = Object.assign(new Error("Throttling: Maximum sending rate exceeded"), {
      $metadata: { httpStatusCode: 400, requestId: "req-1" },
    });
    mailer.sendEmail.mockRejectedValue(throttlingError);

    await expect(processCampaignSend(1)).rejects.toThrow("Throttling: Maximum sending rate exceeded");

    expect(db.claimCampaignSendForSending).toHaveBeenCalledWith(1);
    expect(db.markCampaignSendSent).not.toHaveBeenCalled();
  });

  it("reverts the claim back to 'queued' on a real SES rejection, so a retry can claim it cleanly", async () => {
    db.getCampaignSendDetail.mockResolvedValue(baseDetail);
    db.isEmailSuppressed.mockResolvedValue(false);
    mailer.sendEmail.mockRejectedValue(
      Object.assign(new Error("Throttling: Maximum sending rate exceeded"), {
        $metadata: { httpStatusCode: 400 },
      }),
    );

    await expect(processCampaignSend(1)).rejects.toThrow();

    expect(db.revertCampaignSendToQueued).toHaveBeenCalledWith(1);
  });

  it("does NOT revert-and-retry a network-level failure with no SES response — the outcome is ambiguous, not a known rejection", async () => {
    // Unlike a real SES rejection, a plain network error (timeout, connection
    // reset) has no $metadata — SES may have already accepted the email
    // before the response was lost. Auto-retrying risks a real duplicate
    // send, so this must NOT revert to `queued` or rethrow for BullMQ to retry.
    db.getCampaignSendDetail.mockResolvedValue(baseDetail);
    db.isEmailSuppressed.mockResolvedValue(false);
    mailer.sendEmail.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));

    const result = await processCampaignSend(1);

    expect(db.revertCampaignSendToQueued).not.toHaveBeenCalled();
    expect(db.markCampaignSendFailed).toHaveBeenCalledWith(1, expect.stringMatching(/verify manually/));
    expect(result).toEqual({ skipped: true, reason: "ambiguous send outcome" });
  });

  it("reverts the claim back to 'queued' when the template itself fails to render — a template bug, not an ambiguous crash", async () => {
    // Before the fix, personalizeTemplate ran outside the try/catch: this
    // error would propagate without ever reverting the claim, leaving the
    // row stuck at "sending" and eventually mislabeled "worker crashed,
    // outcome unknown" once BullMQ's retries ran out — even though SES was
    // never once contacted.
    db.getCampaignSendDetail.mockResolvedValue(baseDetail);
    db.isEmailSuppressed.mockResolvedValue(false);
    const templateError = new Error("raw {{{output}}} is not allowed in a template");
    templates.personalizeTemplate.mockImplementation(() => {
      throw templateError;
    });

    await expect(processCampaignSend(1)).rejects.toThrow(/raw .* is not allowed/);

    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(db.revertCampaignSendToQueued).toHaveBeenCalledWith(1);
  });
});
