import { describe, expect, it } from "vitest";
import { parseSesNotification } from "../src/sesNotification.js";

describe("parseSesNotification", () => {
  it("parses a Bounce notification", () => {
    const message = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "a@example.com" }] },
      mail: { messageId: "m1" },
    });
    const parsed = parseSesNotification(message);
    expect(parsed.notificationType).toBe("Bounce");
    expect(parsed.mail.messageId).toBe("m1");
  });

  it("parses a Complaint notification", () => {
    const message = JSON.stringify({
      notificationType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "a@example.com" }] },
      mail: { messageId: "m2" },
    });
    expect(parseSesNotification(message).notificationType).toBe("Complaint");
  });

  it("parses a Delivery notification", () => {
    const message = JSON.stringify({ notificationType: "Delivery", mail: { messageId: "m3" } });
    expect(parseSesNotification(message).notificationType).toBe("Delivery");
  });

  it("returns null for the one-time AmazonSnsSubscriptionSucceeded confirmation SES sends when notifications are first wired up", () => {
    const message = JSON.stringify({ notificationType: "AmazonSnsSubscriptionSucceeded" });
    expect(parseSesNotification(message)).toBeNull();
  });

  it("returns null for AmazonSnsSubscriptionFailed too", () => {
    const message = JSON.stringify({ notificationType: "AmazonSnsSubscriptionFailed" });
    expect(parseSesNotification(message)).toBeNull();
  });

  it("throws on an unknown notificationType instead of processing it silently", () => {
    const message = JSON.stringify({ notificationType: "SomethingElse" });
    expect(() => parseSesNotification(message)).toThrow(/unknown SES notification type/);
  });

  it("throws on malformed JSON rather than crashing with an unhandled parse error downstream", () => {
    expect(() => parseSesNotification("{not json")).toThrow();
  });
});
