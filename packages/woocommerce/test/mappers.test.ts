import { describe, expect, it } from "vitest";
import { classifyShippingMethod, mapWooCustomerToContact, mapWooOrderToOrder, normalizeCityName } from "../src/mappers.js";
import type { WooCustomer, WooOrder } from "../src/types.js";

describe("mapWooCustomerToContact", () => {
  it("maps a WooCommerce customer to the contact upsert shape", () => {
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
    };

    expect(mapWooCustomerToContact(customer)).toEqual({
      email: "cliente@example.com",
      firstName: "Ana",
      lastName: "García",
      wooCustomerId: 42,
      attributes: {},
    });
  });

  it("captures the billing city into attributes when present", () => {
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
      billing: { city: "Barcelona" },
    };

    expect(mapWooCustomerToContact(customer).attributes).toEqual({ city: "Barcelona", comunidadAutonoma: null });
  });

  it("leaves attributes untouched when billing is entirely absent from the payload — not the same as an explicitly blank city", () => {
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
    };

    expect(mapWooCustomerToContact(customer).attributes).toEqual({});
  });

  it("explicitly clears city/comunidadAutonoma to null when billing is present but blank — this store's data can legitimately change", () => {
    // Distinct from billing being entirely absent (previous test): once
    // billing IS present in the payload, it's trusted fully — a blank city
    // here means the customer's address was actually cleared upstream (or a
    // guest checkout gave none), and should overwrite whatever city/region
    // was learned from an earlier, more complete sync rather than leaving
    // it stale forever.
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
      billing: { city: "" },
    };

    expect(mapWooCustomerToContact(customer).attributes).toEqual({ city: null, comunidadAutonoma: null });
  });

  it("normalizes the billing city's casing", () => {
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
      billing: { city: "BARCELONA" },
    };

    expect(mapWooCustomerToContact(customer).attributes).toEqual({ city: "Barcelona", comunidadAutonoma: null });
  });

  it("captures the comunidad autónoma derived from the billing postcode", () => {
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
      billing: { city: "Barcelona", postcode: "08004" },
    };

    expect(mapWooCustomerToContact(customer).attributes).toEqual({
      city: "Barcelona",
      comunidadAutonoma: "Cataluña",
    });
  });

  it("sets comunidadAutonoma to null (not omitted) when billing is present but has no recognizable postcode", () => {
    const customer: WooCustomer = {
      id: 42,
      email: "cliente@example.com",
      first_name: "Ana",
      last_name: "García",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-02T10:00:00",
      billing: { city: "Barcelona" },
    };

    expect(mapWooCustomerToContact(customer).attributes).toEqual({ city: "Barcelona", comunidadAutonoma: null });
  });

  it("maps missing names to null instead of empty strings", () => {
    const customer: WooCustomer = {
      id: 7,
      email: "guest@example.com",
      first_name: "",
      last_name: "",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-01T10:00:00",
    };

    const mapped = mapWooCustomerToContact(customer);
    expect(mapped.firstName).toBeNull();
    expect(mapped.lastName).toBeNull();
  });
});

describe("normalizeCityName", () => {
  it("title-cases an ALL CAPS city", () => {
    expect(normalizeCityName("BARCELONA")).toBe("Barcelona");
    expect(normalizeCityName("HOSPITALET DE LLOBREGAT")).toBe("Hospitalet de Llobregat");
  });

  it("title-cases an all-lowercase city", () => {
    expect(normalizeCityName("barcelona")).toBe("Barcelona");
    expect(normalizeCityName("sant boi de llobregat")).toBe("Sant Boi de Llobregat");
  });

  it("leaves an already mixed-case city untouched", () => {
    expect(normalizeCityName("Barcelona")).toBe("Barcelona");
    expect(normalizeCityName("L'Hospitalet de Llobregat")).toBe("L'Hospitalet de Llobregat");
  });

  it("capitalizes the letter right after an apostrophe", () => {
    expect(normalizeCityName("l'hospitalet de llobregat")).toBe("L'Hospitalet de Llobregat");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeCityName("  Barcelona  ")).toBe("Barcelona");
  });

  it("returns an empty string as-is", () => {
    expect(normalizeCityName("")).toBe("");
    expect(normalizeCityName("   ")).toBe("");
  });
});

describe("mapWooOrderToOrder", () => {
  const baseOrder: WooOrder = {
    id: 100,
    status: "processing",
    currency: "EUR",
    total: "45.90",
    date_created: "2026-08-01T09:00:00",
    date_completed: null,
    customer_id: 42,
    billing: { email: "cliente@example.com", first_name: "Ana", last_name: "García" },
    line_items: [
      { id: 1, name: "Solomillo 1kg", product_id: 10, sku: "SOLO-1KG", quantity: 2, price: 18.5 },
    ],
  };

  it("maps core order fields and dates", () => {
    const mapped = mapWooOrderToOrder(baseOrder);
    expect(mapped.wooOrderId).toBe(100);
    expect(mapped.wooCustomerId).toBe(42);
    expect(mapped.billingEmail).toBe("cliente@example.com");
    expect(mapped.status).toBe("processing");
    expect(mapped.total).toBe("45.90");
    expect(mapped.currency).toBe("EUR");
    expect(mapped.createdAt).toEqual(new Date("2026-08-01T09:00:00"));
    expect(mapped.completedAt).toBeNull();
  });

  it("classifies the shipping method from the title, not the unreliable method_id", () => {
    // Real data: this store's "free_shipping" method_id has, at various
    // points, actually meant SEUR courier delivery once repurposed/relabeled.
    const order: WooOrder = {
      ...baseOrder,
      shipping_lines: [{ method_id: "free_shipping", method_title: "SEUR FRIO (+15€)" }],
    };
    expect(mapWooOrderToOrder(order).shippingMethod).toBe("seur_frio");
  });

  it("takes the first shipping line when there's more than one", () => {
    const order: WooOrder = {
      ...baseOrder,
      shipping_lines: [
        { method_id: "local_pickup", method_title: "Recogida local" },
        { method_id: "flat_rate", method_title: "Seur Frío (15€)" },
      ],
    };
    expect(mapWooOrderToOrder(order).shippingMethod).toBe("local_pickup");
  });

  it("maps to null when there are no shipping lines at all", () => {
    expect(mapWooOrderToOrder(baseOrder).shippingMethod).toBeNull();
    expect(mapWooOrderToOrder({ ...baseOrder, shipping_lines: [] }).shippingMethod).toBeNull();
  });

  it("maps line items, coercing price to string", () => {
    const mapped = mapWooOrderToOrder(baseOrder);
    expect(mapped.items).toEqual([
      {
        wooProductId: 10,
        productName: "Solomillo 1kg",
        sku: "SOLO-1KG",
        category: null,
        quantity: 2,
        price: "18.5",
      },
    ]);
  });

  it("treats a guest order (customer_id 0) as having no woo customer id", () => {
    const guestOrder: WooOrder = { ...baseOrder, customer_id: 0 };
    const mapped = mapWooOrderToOrder(guestOrder);
    expect(mapped.wooCustomerId).toBeNull();
  });

  it("parses date_completed when present", () => {
    const completedOrder: WooOrder = { ...baseOrder, date_completed: "2026-08-02T12:00:00" };
    const mapped = mapWooOrderToOrder(completedOrder);
    expect(mapped.completedAt).toEqual(new Date("2026-08-02T12:00:00"));
  });

  it("maps a guest order with no billing object at all to a null billing email", () => {
    // Real WooCommerce payloads can omit `billing` entirely for some order
    // states — the type says it's always present, but don't trust that at runtime.
    const noBillingOrder = { ...baseOrder, billing: undefined } as unknown as WooOrder;
    const mapped = mapWooOrderToOrder(noBillingOrder);
    expect(mapped.billingEmail).toBeNull();
  });

  it("maps an empty billing email to null instead of an empty string", () => {
    const order: WooOrder = { ...baseOrder, billing: { ...baseOrder.billing, email: "" } };
    const mapped = mapWooOrderToOrder(order);
    expect(mapped.billingEmail).toBeNull();
  });

  it("handles a WooCommerce order with no line items", () => {
    const order: WooOrder = { ...baseOrder, line_items: [] };
    const mapped = mapWooOrderToOrder(order);
    expect(mapped.items).toEqual([]);
  });

  it("coerces a string line-item price (as WooCommerce's REST API actually returns it)", () => {
    const order: WooOrder = {
      ...baseOrder,
      line_items: [{ id: 1, name: "Solomillo 1kg", product_id: 10, sku: "SOLO-1KG", quantity: 1, price: "18.5" as unknown as number }],
    };
    const mapped = mapWooOrderToOrder(order);
    expect(mapped.items[0].price).toBe("18.5");
  });
});

describe("mapWooCustomerToContact edge cases", () => {
  it("passes through an empty email as-is rather than fabricating one", () => {
    // WooCommerce customer accounts always require an email, but don't crash if a
    // malformed payload ever lacks one — the caller decides whether to skip it.
    const customer: WooCustomer = {
      id: 1,
      email: "",
      first_name: "Sin",
      last_name: "Email",
      date_created: "2026-01-01T10:00:00",
      date_modified: "2026-01-01T10:00:00",
    };
    expect(mapWooCustomerToContact(customer).email).toBe("");
  });
});

describe("classifyShippingMethod", () => {
  // Real titles seen in this store's order history — years of shipping-plugin
  // reconfiguration produced a lot of variety for what are really 3 concepts.
  it("classifies SEUR titles, in any of their real variants", () => {
    for (const title of [
      "Envío refrigerado 24h (SEUR Frío)",
      "Seur Frío (15€)",
      "Seur Frío 24H",
      "SEUR FRIO (+15€)",
      "Envío Seur Frio",
      "Seur Frio",
    ]) {
      expect(classifyShippingMethod(title)).toBe("seur_frio");
    }
  });

  it("classifies pickup titles, in any of their real variants", () => {
    for (const title of [
      "Recogida presencial en Tienda (Barcelona)",
      "Recogida local",
      "Recogida en Tienda",
      "Recogida en tienda",
      "Recogida Local",
    ]) {
      expect(classifyShippingMethod(title)).toBe("local_pickup");
    }
  });

  it("classifies home-delivery titles, including zone-based ones", () => {
    for (const title of [
      "Envío a domicilio — ¡GRATIS!",
      "Envío GRATIS a domicilio",
      "Envío a domicilio (te confirmamos el coste)",
      "Envío Zona 1",
      "Envío Zona 1 (Envío Gratuito)",
      "ENVIO ZONA 1 BIS (Gratuito)",
      "Envío Zona 2",
      // Some older orders just say this, with no zone/domicilio detail —
      // never used for SEUR or pickup in this store's real history.
      "Envío gratuito",
      "Envío",
    ]) {
      expect(classifyShippingMethod(title)).toBe("home_delivery");
    }
  });

  it("classifies SEUR even when the title also happens to say envío", () => {
    expect(classifyShippingMethod("Envío Seur Frio")).toBe("seur_frio");
  });

  it("returns null for a title matching nothing recognizable, rather than guessing", () => {
    expect(classifyShippingMethod("Flexible Shipping")).toBeNull();
    expect(classifyShippingMethod("")).toBeNull();
    expect(classifyShippingMethod(undefined)).toBeNull();
    expect(classifyShippingMethod(null)).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(classifyShippingMethod("recogida EN TIENDA")).toBe("local_pickup");
  });
});
