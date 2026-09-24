import { describe, expect, it } from "vitest";
import { categorizeSegment, groupSegmentsForPicker } from "../src/categorize.js";
import { parseRuleGroup } from "../src/types.js";

// The 7 real segments in production as of writing — locking in their
// category so a future change to conditionCategory()'s mapping can't
// silently reshuffle where an existing segment shows up in the campaign
// form's picker.
const REAL_SEGMENTS = [
  {
    id: 1,
    name: "Todos",
    definition: { glue: "and", conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }] },
  },
  {
    id: 2,
    name: "Activos (últimos 60 días)",
    definition: { glue: "and", conditions: [{ kind: "order_exists", op: "any", withinDays: 60 }] },
  },
  {
    id: 3,
    name: "Barcelona",
    definition: { glue: "and", conditions: [{ kind: "contact_attribute", path: "city", op: "eq", value: "Barcelona" }] },
  },
  {
    id: 4,
    name: "Seur Frío",
    definition: { glue: "and", conditions: [{ kind: "order_exists", op: "any", shippingMethod: "seur_frio" }] },
  },
  {
    id: 5,
    name: "Recogida en tienda",
    definition: { glue: "and", conditions: [{ kind: "order_exists", op: "any", shippingMethod: "local_pickup" }] },
  },
  {
    id: 6,
    name: "Solo domicilio (nunca pisaron la tienda)",
    definition: {
      glue: "and",
      conditions: [
        { kind: "order_exists", op: "any", shippingMethod: "home_delivery" },
        { kind: "order_exists", op: "none", shippingMethod: "local_pickup" },
        { kind: "order_exists", op: "none", shippingMethod: "seur_frio" },
      ],
    },
  },
  {
    id: 7,
    name: "Nuevos suscriptores (últimos 30 días)",
    definition: { glue: "and", conditions: [{ kind: "contact_field", field: "createdAt", op: "gte", withinDays: 30 }] },
  },
];

describe("categorizeSegment", () => {
  it("categorizes each of the 7 real production segments as expected", () => {
    const categories = Object.fromEntries(
      REAL_SEGMENTS.map((s) => [s.name, categorizeSegment(parseRuleGroup(s.definition))]),
    );
    expect(categories).toEqual({
      Todos: "Audiencia general",
      "Activos (últimos 60 días)": "Actividad de compra",
      Barcelona: "Ubicación del contacto",
      "Seur Frío": "Método de entrega",
      "Recogida en tienda": "Método de entrega",
      "Solo domicilio (nunca pisaron la tienda)": "Método de entrega",
      "Nuevos suscriptores (últimos 30 días)": "Antigüedad de suscripción",
    });
  });

  it("falls back to the most specific category when conditions mix kinds", () => {
    const rule = parseRuleGroup({
      glue: "and",
      conditions: [
        { kind: "contact_field", field: "status", op: "eq", value: "subscribed" },
        { kind: "contact_attribute", path: "city", op: "eq", value: "Barcelona" },
      ],
    });
    expect(categorizeSegment(rule)).toBe("Ubicación del contacto");
  });
});

describe("groupSegmentsForPicker", () => {
  it("orders the 7 real segments broadest-to-narrowest, alphabetical within each group", () => {
    expect(groupSegmentsForPicker(REAL_SEGMENTS)).toEqual([
      { category: "Audiencia general", segments: [{ id: 1, name: "Todos" }] },
      { category: "Actividad de compra", segments: [{ id: 2, name: "Activos (últimos 60 días)" }] },
      {
        category: "Antigüedad de suscripción",
        segments: [{ id: 7, name: "Nuevos suscriptores (últimos 30 días)" }],
      },
      {
        category: "Método de entrega",
        segments: [
          { id: 5, name: "Recogida en tienda" },
          { id: 4, name: "Seur Frío" },
          { id: 6, name: "Solo domicilio (nunca pisaron la tienda)" },
        ],
      },
      { category: "Ubicación del contacto", segments: [{ id: 3, name: "Barcelona" }] },
    ]);
  });

  it("puts a segment with an unparseable definition into 'Otros' instead of throwing", () => {
    const grouped = groupSegmentsForPicker([{ id: 99, name: "Roto", definition: null }]);
    expect(grouped).toEqual([{ category: "Otros", segments: [{ id: 99, name: "Roto" }] }]);
  });

  it("omits empty categories entirely", () => {
    const grouped = groupSegmentsForPicker([REAL_SEGMENTS[0]]);
    expect(grouped).toEqual([{ category: "Audiencia general", segments: [{ id: 1, name: "Todos" }] }]);
  });
});
