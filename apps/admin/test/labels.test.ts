import { describe, expect, it } from "vitest";
import { campaignStatusLabel, listOptinLabel, sendStatusLabel } from "../src/labels.js";

describe("campaignStatusLabel", () => {
  it("translates every known campaign_status enum value", () => {
    expect(campaignStatusLabel("draft")).toBe("Borrador");
    expect(campaignStatusLabel("scheduled")).toBe("Programada");
    expect(campaignStatusLabel("sending")).toBe("Enviando");
    expect(campaignStatusLabel("sent")).toBe("Enviada");
    expect(campaignStatusLabel("paused")).toBe("Pausada");
  });

  it("falls back to the raw value for anything unrecognized, instead of throwing", () => {
    expect(campaignStatusLabel("something-new")).toBe("something-new");
  });
});

describe("sendStatusLabel", () => {
  it("translates every known send_status enum value", () => {
    expect(sendStatusLabel("queued")).toBe("En cola");
    expect(sendStatusLabel("sending")).toBe("Enviando");
    expect(sendStatusLabel("sent")).toBe("Enviado");
    expect(sendStatusLabel("failed")).toBe("Fallido");
    expect(sendStatusLabel("bounced")).toBe("Rebotado");
    expect(sendStatusLabel("suppressed")).toBe("Suprimido");
    expect(sendStatusLabel("complained")).toBe("Marcó como spam");
  });
});

describe("listOptinLabel", () => {
  it("translates both optin values", () => {
    expect(listOptinLabel("single")).toBe("Simple");
    expect(listOptinLabel("double")).toBe("Doble");
  });
});
