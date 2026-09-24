import { describe, expect, it } from "vitest";
import {
  assertKnownMergeTags,
  assertNoRawOutput,
  assertNoUnresolvedPlaceholders,
  extractCampaignFieldNames,
  renderTemplate,
} from "../src/render.js";

const baseContact = {
  firstName: "María",
  lastName: "García",
  email: "maria@example.com",
  attributes: { favoriteCategory: "embutidos" },
};

describe("renderTemplate", () => {
  it("substitutes contact fields and system variables", () => {
    const html = renderTemplate("<p>Hola {{contact.firstName}}, <a href=\"{{unsubscribeUrl}}\">baja</a></p>", {
      contact: baseContact,
      unsubscribeUrl: "https://track.example.com/unsubscribe/abc",
    });
    expect(html).toBe('<p>Hola María, <a href="https://track.example.com/unsubscribe/abc">baja</a></p>');
  });

  it("reads nested JSONB attributes", () => {
    const html = renderTemplate("{{contact.attributes.favoriteCategory}}", {
      contact: baseContact,
      unsubscribeUrl: "https://track.example.com/unsubscribe/abc",
    });
    expect(html).toBe("embutidos");
  });

  it("falls back to empty string for a missing field instead of throwing", () => {
    const html = renderTemplate("Hola {{contact.firstName}}{{contact.attributes.nope}}", {
      contact: { ...baseContact, firstName: null },
      unsubscribeUrl: "https://track.example.com/unsubscribe/abc",
    });
    expect(html).toBe("Hola ");
  });

  it("HTML-escapes contact data (no raw HTML injection via merge tags)", () => {
    const html = renderTemplate("{{contact.firstName}}", {
      contact: { ...baseContact, firstName: "<script>alert(1)</script>" },
      unsubscribeUrl: "https://track.example.com/unsubscribe/abc",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("has no custom helpers registered — only Handlebars' safe #each/#if built-ins work", () => {
    const html = renderTemplate("{{#each contact.attributes}}{{this}}{{/each}}", {
      contact: { ...baseContact, attributes: { a: "x", b: "y" } },
      unsubscribeUrl: "https://track.example.com/unsubscribe/abc",
    });
    expect(html).toBe("xy");
  });

  it("rejects triple-stache raw output ({{{...}}}) instead of rendering it unescaped", () => {
    expect(() => renderTemplate("{{{contact.firstName}}}", { contact: baseContact, unsubscribeUrl: "u" })).toThrow(
      /sin escapar/,
    );
  });

  it("rejects the {{&...}} raw-output form too", () => {
    expect(() => renderTemplate("{{& contact.firstName}}", { contact: baseContact, unsubscribeUrl: "u" })).toThrow(
      /sin escapar/,
    );
  });

  it("rejects raw output nested inside a block helper, not just at the top level", () => {
    const html = "{{#if contact.firstName}}{{{contact.firstName}}}{{/if}}";
    expect(() => renderTemplate(html, { contact: baseContact, unsubscribeUrl: "u" })).toThrow(/sin escapar/);
  });

  it("still allows normal escaped output alongside other content", () => {
    expect(() => assertNoRawOutput("<p>Hola {{contact.firstName}}</p>")).not.toThrow();
  });

  it("gives a friendly, actionable message for a merge tag split by an HTML tag boundary", () => {
    // The exact shape GrapesJS can produce if someone selects only part of a
    // tag inside the visual editor and applies bold/color to it.
    expect(() => assertNoRawOutput("<b>{{campaign</b>.titulo}}")).toThrow(/variable.*rota o incompleta/);
  });

  it("rejects a mistyped merge tag instead of silently rendering it blank", () => {
    // Wrong case ("FirstName") — with strict:false this would otherwise
    // render as an empty string, indistinguishable from a contact that
    // legitimately has no first name.
    expect(() => renderTemplate("Hola {{contact.FirstName}}", { contact: baseContact, unsubscribeUrl: "u" })).toThrow(
      /campo desconocido.*contact\.FirstName/,
    );
  });

  it("substitutes {{campaign.*}} fields from the per-send content the campaign form fills in", () => {
    const html = renderTemplate("{{campaign.titulo}}: {{campaign.precio}}", {
      contact: baseContact,
      unsubscribeUrl: "u",
      campaign: { titulo: "Hamburguesas de ternera", precio: "11,90 € / kg" },
    });
    expect(html).toBe("Hamburguesas de ternera: 11,90 € / kg");
  });

  it("renders a {{campaign.*}} field blank when no campaign data is supplied — same as an unset preview", () => {
    const html = renderTemplate("Precio: {{campaign.precio}}", { contact: baseContact, unsubscribeUrl: "u" });
    expect(html).toBe("Precio: ");
  });
});

describe("assertKnownMergeTags", () => {
  it("accepts every field this app actually supports", () => {
    const html =
      "{{contact.firstName}} {{contact.lastName}} {{contact.email}} {{contact.attributes.city}} {{unsubscribeUrl}}";
    expect(() => assertKnownMergeTags(html)).not.toThrow();
  });

  it("accepts contact.firstName used as an #if condition, with an #else branch", () => {
    // The exact pattern every real production template uses for the greeting.
    const html = "{{#if contact.firstName}}Hola {{contact.firstName}}{{else}}Hola{{/if}},";
    expect(() => assertKnownMergeTags(html)).not.toThrow();
  });

  it("accepts contact.attributes used bare, e.g. inside #each", () => {
    expect(() => assertKnownMergeTags("{{#each contact.attributes}}{{this}}{{/each}}")).not.toThrow();
  });

  it("rejects a field that doesn't exist, naming the exact tag", () => {
    expect(() => assertKnownMergeTags("{{contact.middleName}}")).toThrow(/contact\.middleName/);
  });

  it("rejects a wrong-case typo used inside an #if condition, not just a bare mustache", () => {
    expect(() => assertKnownMergeTags("{{#if contact.Firstname}}hi{{/if}}")).toThrow(/contact\.Firstname/);
  });

  it("does not flag a legitimately empty contact.attributes.* field as unknown", () => {
    // This is the false-positive a render-and-check-for-blank approach would
    // produce; the static path check has no way to distinguish "empty" from
    // "missing" and correctly doesn't try to.
    expect(() => assertKnownMergeTags("{{contact.attributes.city}}")).not.toThrow();
  });

  it("accepts any {{campaign.*}} field name — a template author defines its own, no fixed list", () => {
    expect(() => assertKnownMergeTags("{{campaign.titulo}} {{campaign.whateverNameIWant}}")).not.toThrow();
  });

  it("accepts campaign used bare, e.g. inside #each — same allowance as contact.attributes", () => {
    expect(() => assertKnownMergeTags("{{#each campaign}}{{this}}{{/each}}")).not.toThrow();
  });
});

describe("extractCampaignFieldNames", () => {
  it("collects every distinct {{campaign.*}} field, in first-use order", () => {
    const html = "{{campaign.titulo}} {{campaign.precio}} {{campaign.titulo}}";
    expect(extractCampaignFieldNames(html)).toEqual(["titulo", "precio"]);
  });

  it("finds a campaign field used as an #if condition too, not just a bare mustache", () => {
    const html = "{{#if campaign.imagen}}<img src=\"{{campaign.imagen}}\">{{/if}}";
    expect(extractCampaignFieldNames(html)).toEqual(["imagen"]);
  });

  it("ignores contact fields and returns an empty list for a template with none", () => {
    expect(extractCampaignFieldNames("Hola {{contact.firstName}}, {{unsubscribeUrl}}")).toEqual([]);
  });
});

describe("assertNoUnresolvedPlaceholders", () => {
  it("rejects real leftover placeholder text, naming it", () => {
    expect(() => assertNoUnresolvedPlaceholders("<p>[DESCUENTO]% en tu próximo pedido</p>")).toThrow(
      /texto de relleno.*\[DESCUENTO\]/,
    );
  });

  it("does not flag an Outlook conditional comment as a placeholder", () => {
    // <!--[if mso]-->...<!--[endif]--> is a standard technique for
    // Outlook-only fixes in real email HTML — it must stay usable.
    expect(() =>
      assertNoUnresolvedPlaceholders("<!--[if mso]--><table><tr><td>Fallback</td></tr></table><!--[endif]-->"),
    ).not.toThrow();
  });

  it("does not flag a CSS attribute selector inside a <style> block as a placeholder", () => {
    // A common hack to stop iOS/Gmail from auto-linking phone numbers.
    expect(() =>
      assertNoUnresolvedPlaceholders('<style>a[href^="tel:"], a[href^="sms"] { color: inherit; }</style><p>Hola</p>'),
    ).not.toThrow();
  });

  it("still catches a real placeholder sitting right next to a conditional comment", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders("<!--[if mso]-->x<!--[endif]--><p>[Ej: completá esto]</p>"),
    ).toThrow(/\[Ej: completá esto\]/);
  });
});
