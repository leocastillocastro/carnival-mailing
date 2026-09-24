import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildStringToSign, verifySignatureWithKey, type SnsSignedEnvelope } from "../src/verifySnsSignature.js";

describe("buildStringToSign", () => {
  // Exact example from AWS's own docs: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html
  it("matches AWS's documented example for a Notification message", () => {
    const envelope = {
      Type: "Notification",
      Message: "My Test Message",
      MessageId: "4d4dc071-ddbf-465d-bba8-08f81c89da64",
      Subject: "My subject",
      Timestamp: "2019-01-31T04:37:04.321Z",
      TopicArn: "arn:aws:sns:us-east-2:123456789012:s4-MySNSTopic-1G1WEFCOXTC0P",
    } as unknown as SnsSignedEnvelope;

    expect(buildStringToSign(envelope)).toBe(
      "Message\nMy Test Message\n" +
        "MessageId\n4d4dc071-ddbf-465d-bba8-08f81c89da64\n" +
        "Subject\nMy subject\n" +
        "Timestamp\n2019-01-31T04:37:04.321Z\n" +
        "TopicArn\narn:aws:sns:us-east-2:123456789012:s4-MySNSTopic-1G1WEFCOXTC0P\n" +
        "Type\nNotification\n",
    );
  });

  it("omits Subject when absent, without leaving a gap in the field order", () => {
    const envelope = {
      Type: "Notification",
      Message: "msg",
      MessageId: "id1",
      Timestamp: "t1",
      TopicArn: "arn1",
    } as unknown as SnsSignedEnvelope;

    expect(buildStringToSign(envelope)).toBe("Message\nmsg\nMessageId\nid1\nTimestamp\nt1\nTopicArn\narn1\nType\nNotification\n");
  });

  it("uses the SubscriptionConfirmation field set (SubscribeURL + Token, no Subject) for that type", () => {
    const envelope = {
      Type: "SubscriptionConfirmation",
      Message: "Please confirm",
      MessageId: "sub-1",
      SubscribeURL: "https://sns.eu-west-1.amazonaws.com/confirm",
      Timestamp: "t1",
      Token: "tok1",
      TopicArn: "arn1",
    } as unknown as SnsSignedEnvelope;

    expect(buildStringToSign(envelope)).toBe(
      "Message\nPlease confirm\nMessageId\nsub-1\nSubscribeURL\nhttps://sns.eu-west-1.amazonaws.com/confirm\n" +
        "Timestamp\nt1\nToken\ntok1\nTopicArn\narn1\nType\nSubscriptionConfirmation\n",
    );
  });

  it("throws when a required (non-Subject) field is missing", () => {
    const envelope = { Type: "Notification", Message: "msg", MessageId: "id1" } as unknown as SnsSignedEnvelope;
    expect(() => buildStringToSign(envelope)).toThrow(/Timestamp/);
  });
});

describe("verifySignatureWithKey", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stringToSign = "Message\nhi\nMessageId\nid1\nTimestamp\nt1\nTopicArn\narn1\nType\nNotification\n";

  function sign(algorithm: "RSA-SHA1" | "RSA-SHA256", data: string): string {
    return cryptoSign(algorithm, Buffer.from(data, "utf8"), privateKey).toString("base64");
  }

  it("verifies a genuine SignatureVersion 2 (SHA256) signature", () => {
    const signature = sign("RSA-SHA256", stringToSign);
    expect(verifySignatureWithKey(stringToSign, signature, publicKey, "2")).toBe(true);
  });

  it("verifies a genuine SignatureVersion 1 (SHA1) signature", () => {
    const signature = sign("RSA-SHA1", stringToSign);
    expect(verifySignatureWithKey(stringToSign, signature, publicKey, "1")).toBe(true);
  });

  it("rejects a signature for different data (tampered message)", () => {
    const signature = sign("RSA-SHA256", stringToSign);
    expect(verifySignatureWithKey("Message\ntampered\n", signature, publicKey, "2")).toBe(false);
  });

  it("rejects a well-formed but wrong signature", () => {
    const otherKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signature = cryptoSign("RSA-SHA256", Buffer.from(stringToSign, "utf8"), otherKeyPair.privateKey).toString(
      "base64",
    );
    expect(verifySignatureWithKey(stringToSign, signature, publicKey, "2")).toBe(false);
  });

  it("rejects an unsupported signature version outright", () => {
    const signature = sign("RSA-SHA256", stringToSign);
    expect(verifySignatureWithKey(stringToSign, signature, publicKey, "3")).toBe(false);
  });
});
