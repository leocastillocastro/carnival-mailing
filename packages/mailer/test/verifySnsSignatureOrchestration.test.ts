import { sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStringToSign, verifySnsSignature, type SnsSignedEnvelope } from "../src/verifySnsSignature.js";

// vi.mock factories are hoisted above regular top-level code, so the key pair
// they close over must go through vi.hoisted() too — a plain `const` here
// would still be in its TDZ when the factory actually runs.
const { publicKey, privateKey } = vi.hoisted(() => {
  // Plain ESM imports of "node:crypto" below are the module vi.mock replaces,
  // so the real generateKeyPairSync has to come from a require() done here,
  // before that mock is even registered.
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
});

// X509Certificate needs a real DER/PEM certificate structure to parse — these
// tests only care that the code path extracts and uses whatever `.publicKey`
// it gets back, so the class itself is stubbed to hand back our real test key
// pair without needing an actual AWS-signed certificate file. `vi.mock` is
// hoisted above this file's imports, so the static import above already sees
// the mocked `node:crypto`.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  // Vitest 4's spy implementation only supports `new`-invocation when the
  // mock implementation is itself a real constructable function — an arrow
  // function silently produces the wrong result instead of throwing.
  return { ...actual, X509Certificate: vi.fn().mockImplementation(function () { return { publicKey }; }) };
});

const CERT_URL = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-cert.pem";
const STUB_CERT_PEM = "-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----";

const baseEnvelope: SnsSignedEnvelope = {
  Type: "Notification",
  Message: "hi",
  MessageId: "id1",
  Timestamp: "t1",
  TopicArn: "arn1",
  SignatureVersion: "2",
  Signature: "",
  SigningCertURL: CERT_URL,
};

function withValidSignature(envelope: SnsSignedEnvelope): SnsSignedEnvelope {
  const stringToSign = buildStringToSign(envelope);
  const signature = cryptoSign("RSA-SHA256", Buffer.from(stringToSign, "utf8"), privateKey).toString("base64");
  return { ...envelope, Signature: signature };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(STUB_CERT_PEM) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifySnsSignature", () => {
  it("returns true for a genuinely-signed envelope with a trusted cert host", async () => {
    expect(await verifySnsSignature(withValidSignature(baseEnvelope))).toBe(true);
  });

  it("returns false for a tampered signature even with a trusted cert host", async () => {
    const tampered = { ...withValidSignature(baseEnvelope), Message: "something else" };
    expect(await verifySnsSignature(tampered)).toBe(false);
  });

  it("returns false and never fetches when SigningCertURL is not an AWS host (SSRF guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const envelope = withValidSignature({ ...baseEnvelope, SigningCertURL: "https://evil.example.com/cert.pem" });
    expect(await verifySnsSignature(envelope)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false instead of throwing when fetching the cert fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    // A URL not used by the other tests — verifySnsSignature caches successful
    // cert fetches, and reusing CERT_URL here would silently hit that cache
    // instead of exercising the failure path this test is actually about.
    const envelope = { ...baseEnvelope, SigningCertURL: "https://sns.eu-west-1.amazonaws.com/unfetchable-cert.pem" };
    await expect(verifySnsSignature(withValidSignature(envelope))).resolves.toBe(false);
  });
});
