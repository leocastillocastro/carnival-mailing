import { describe, expect, it } from "vitest";

// sendEmail.ts imports sesClient.ts, which eagerly constructs an SESv2Client
// from SES_REGION at module-evaluation time — a value this test (which only
// exercises the pure sesDefinitelyRejected helper) never otherwise needs.
process.env.SES_REGION ??= "eu-west-1";

const { sesDefinitelyRejected } = await import("../src/sendEmail.js");

describe("sesDefinitelyRejected", () => {
  it("is true for an AWS SDK error that carries $metadata.httpStatusCode — SES actually answered", () => {
    const err = Object.assign(new Error("Throttling: Maximum sending rate exceeded"), {
      $metadata: { httpStatusCode: 400, requestId: "abc-123" },
    });
    expect(sesDefinitelyRejected(err)).toBe(true);
  });

  it("is false for a plain network-level error with no $metadata — SES may have already accepted the message", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(sesDefinitelyRejected(err)).toBe(false);
  });

  it("is false for a bare Error with no AWS-specific shape at all", () => {
    expect(sesDefinitelyRejected(new Error("SES did not return a MessageId"))).toBe(false);
  });

  it("is false for non-object thrown values", () => {
    expect(sesDefinitelyRejected("a string error")).toBe(false);
    expect(sesDefinitelyRejected(null)).toBe(false);
    expect(sesDefinitelyRejected(undefined)).toBe(false);
  });

  it("is false when $metadata exists but httpStatusCode is missing (an incomplete/unexpected shape)", () => {
    const err = Object.assign(new Error("weird"), { $metadata: { requestId: "abc-123" } });
    expect(sesDefinitelyRejected(err)).toBe(false);
  });
});
