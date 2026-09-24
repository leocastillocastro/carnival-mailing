import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWooSignature } from "../src/webhookVerify.js";

const secret = "test-secret";
const body = JSON.stringify({ id: 123, status: "processing" });

function sign(payload: string, key: string) {
  return createHmac("sha256", key).update(payload).digest("base64");
}

describe("verifyWooSignature", () => {
  it("accepts a signature computed with the correct secret", () => {
    const signature = sign(body, secret);
    expect(verifyWooSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = sign(body, "wrong-secret");
    expect(verifyWooSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(body, secret);
    const tamperedBody = JSON.stringify({ id: 123, status: "cancelled" });
    expect(verifyWooSignature(tamperedBody, signature, secret)).toBe(false);
  });

  it("rejects when the signature header is missing", () => {
    expect(verifyWooSignature(body, undefined, secret)).toBe(false);
  });
});
