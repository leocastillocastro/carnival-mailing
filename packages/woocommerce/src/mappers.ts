import { comunidadAutonomaFromPostcode } from "./spanishRegions.js";
import type { WooCustomer, WooOrder } from "./types.js";

export interface MappedContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  wooCustomerId: number;
  // Only ever contains keys we actually have a value for — the repository
  // merges this into the contact's existing attributes rather than
  // replacing them, so a customer payload with no billing city must not
  // clobber a city learned earlier from an order.
  attributes: Record<string, unknown>;
}

// Spanish/Catalan articles and prepositions that stay lowercase mid-name
// (e.g. "Hospitalet de Llobregat", "Sant Boi de Llobregat").
const LOWERCASE_PARTICLES = new Set(["de", "del", "la", "las", "los", "el", "i", "y"]);

function capitalizeWord(word: string): string {
  if (!word) return word;
  const chars = word.split("");
  chars[0] = chars[0].toUpperCase();
  // Handles names like "l'hospitalet" -> "L'Hospitalet".
  const apostropheIndex = word.search(/['’]/);
  if (apostropheIndex >= 0 && apostropheIndex + 1 < chars.length) {
    chars[apostropheIndex + 1] = chars[apostropheIndex + 1].toUpperCase();
  }
  return chars.join("");
}

// WooCommerce billing city is free text, so the same real city ends up
// stored as "Barcelona", "barcelona" and "BARCELONA" depending on how each
// customer typed it — which would silently fragment a "por ciudad" segment.
// Only ALL-CAPS or all-lowercase input gets rewritten; anything already
// mixed-case (e.g. "L'Hospitalet de Llobregat") is assumed to be typed
// correctly already and left untouched, since a generic title-case pass
// would mangle names built from apostrophes/particles it doesn't recognize.
export function normalizeCityName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const hasUpper = /[A-ZÁÉÍÓÚÑÜ]/.test(trimmed);
  const hasLower = /[a-záéíóúñü]/.test(trimmed);
  if (hasUpper && hasLower) return trimmed;

  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word, i) => (i > 0 && LOWERCASE_PARTICLES.has(word) ? word : capitalizeWord(word)))
    .join(" ");
}

// This store's shipping method_id is NOT reliable on its own: years of
// reconfiguring its shipping plugin (Flexible Shipping) mean the same
// method_id has meant different things at different times (e.g. some old
// orders carry method_id "free_shipping" with the title "SEUR FRIO (+15€)"
// — a since-repurposed free-shipping slot the store later used to charge for
// courier delivery). The title text itself is the one thing that's stayed a
// consistent signal of what the customer actually chose, across every
// plugin/zone reconfiguration — so classify by keyword match on the title,
// the same normalize-messy-real-data approach as normalizeCityName above.
export function classifyShippingMethod(methodTitle: string | undefined | null): string | null {
  if (!methodTitle) return null;
  const normalized = methodTitle.toLowerCase();
  if (normalized.includes("seur")) return "seur_frio";
  if (normalized.includes("recogida")) return "local_pickup";
  // "domicilio"/"zona" are this store's usual home-delivery wording, but some
  // older orders just say "Envío" or "Envío gratuito" with no other detail —
  // never "recogida" or "seur" on their own, so still safely home delivery.
  if (normalized.includes("domicilio") || normalized.includes("zona") || normalized.includes("envío") || normalized.includes("envio")) {
    return "home_delivery";
  }
  return null;
}

export function mapWooCustomerToContact(customer: WooCustomer): MappedContact {
  const attributes: Record<string, unknown> = {};
  // Only touch these keys at all when `billing` is present in the payload —
  // its total absence just means this particular sync didn't include
  // billing info, not "the customer has no address anymore", and must not
  // clear a value learned from an earlier, more complete sync. But once
  // `billing` IS present, trust it fully: an explicitly blank city clears
  // the stored value (via the jsonb `||` merge in upsertContactFromWoo,
  // which overwrites with null same as any other value) instead of leaving
  // a stale city/region from before the customer's address was cleared.
  if (customer.billing) {
    attributes.city = customer.billing.city ? normalizeCityName(customer.billing.city) : null;
    attributes.comunidadAutonoma = comunidadAutonomaFromPostcode(customer.billing.postcode);
  }

  return {
    email: customer.email,
    firstName: customer.first_name || null,
    lastName: customer.last_name || null,
    wooCustomerId: customer.id,
    attributes,
  };
}

export interface MappedOrder {
  wooOrderId: number;
  wooCustomerId: number | null;
  billingEmail: string | null;
  status: string;
  total: string | null;
  currency: string | null;
  createdAt: Date;
  completedAt: Date | null;
  // "home_delivery" | "seur_frio" | "local_pickup" | null — see
  // classifyShippingMethod. Stored as free text rather than an enum, since
  // this classification can gain new categories without a matching migration.
  shippingMethod: string | null;
  items: Array<{
    wooProductId: number | null;
    productName: string;
    sku: string | null;
    category: string | null;
    quantity: number;
    price: string;
  }>;
}

export function mapWooOrderToOrder(order: WooOrder): MappedOrder {
  return {
    wooOrderId: order.id,
    wooCustomerId: order.customer_id || null,
    billingEmail: order.billing?.email || null,
    status: order.status,
    total: order.total || null,
    currency: order.currency || null,
    createdAt: new Date(order.date_created),
    completedAt: order.date_completed ? new Date(order.date_completed) : null,
    // Orders in this store carry exactly one shipping line; take the first
    // defensively rather than assuming that always holds.
    shippingMethod: classifyShippingMethod(order.shipping_lines?.[0]?.method_title),
    items: (order.line_items ?? []).map((item) => ({
      wooProductId: item.product_id || null,
      productName: item.name,
      sku: item.sku || null,
      // WooCommerce order line items don't carry the product category —
      // it would require a separate per-product lookup. Left null for now.
      category: null,
      quantity: item.quantity,
      price: String(item.price),
    })),
  };
}
