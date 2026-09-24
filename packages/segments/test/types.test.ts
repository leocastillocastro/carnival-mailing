import { describe, expect, it } from "vitest";
import { assertRuleGroupSize, parseRuleGroup } from "../src/types.js";

function buildDeeplyNested(levels: number) {
  let group: unknown = { glue: "and", conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }] };
  for (let i = 0; i < levels; i++) {
    group = { glue: "and", conditions: [group] };
  }
  return group;
}

describe("parseRuleGroup", () => {
  it("rejects an empty conditions array with a friendly Spanish message, at any nesting level", () => {
    expect(() => parseRuleGroup({ glue: "and", conditions: [] })).toThrow("Agregá al menos una condición");
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ glue: "or", conditions: [] }],
      }),
    ).toThrow("Agregá al menos una condición");
  });

  it("parses a single contact_field condition", () => {
    const rule = parseRuleGroup({
      glue: "and",
      conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed" }],
    });
    expect(rule.conditions).toHaveLength(1);
  });

  it("parses nested groups (group inside a group)", () => {
    const rule = parseRuleGroup({
      glue: "or",
      conditions: [
        {
          glue: "and",
          conditions: [
            { kind: "contact_field", field: "status", op: "eq", value: "subscribed" },
            { kind: "list_membership", listId: 1 },
          ],
        },
        { kind: "event_exists", op: "any", type: "click" },
      ],
    });
    expect(rule.conditions).toHaveLength(2);
  });

  it("parses an order_exists condition with a shippingMethod filter", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "order_exists", op: "any", shippingMethod: "flat_rate" }],
      }),
    ).not.toThrow();
  });

  it("allows isEmpty/isNotEmpty without a value", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_attribute", path: "phone", op: "isEmpty" }],
      }),
    ).not.toThrow();
  });

  it("rejects eq/gt/etc without a value", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_field", field: "email", op: "eq" }],
      }),
    ).toThrow();
  });

  it("rejects an unknown condition kind", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "raw_sql", query: "DROP TABLE contacts" }],
      }),
    ).toThrow();
  });

  it("rejects an unknown contact_field field (allowlist)", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_field", field: "isAdmin", op: "eq", value: true }],
      }),
    ).toThrow();
  });

  it("rejects 'contains' (or any non-equality op) against the status enum", () => {
    // compile.ts has no valid SQL operator for LIKE/gt/lt against
    // contact_status — this must be caught before it ever reaches Postgres.
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_field", field: "status", op: "contains", value: "sub" }],
      }),
    ).toThrow(/status/);
  });

  it("accepts eq/neq/isEmpty/isNotEmpty against status", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_field", field: "status", op: "neq", value: "bounced" }],
      }),
    ).not.toThrow();
  });

  it("rejects a leftover withinDays on a field other than createdAt", () => {
    // Real repro: the segment builder sets withinDays while a condition's
    // field is "createdAt", then the user switches the field away without
    // recreating the condition — compile.ts would otherwise silently use the
    // stale withinDays as a rolling-window comparison against a column that
    // isn't a date.
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_field", field: "status", op: "eq", value: "subscribed", withinDays: 30 }],
      }),
    ).toThrow(/withinDays/);
  });

  it("accepts withinDays on createdAt", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "contact_field", field: "createdAt", op: "eq", withinDays: 30 }],
      }),
    ).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "event_exists", op: "any", type: "purchase" }],
      }),
    ).toThrow();
  });

  it("rejects a non-positive listId", () => {
    expect(() =>
      parseRuleGroup({
        glue: "and",
        conditions: [{ kind: "list_membership", listId: 0 }],
      }),
    ).toThrow();
  });

  it("rejects an empty conditions array", () => {
    expect(() => parseRuleGroup({ glue: "and", conditions: [] })).toThrow();
  });

  it("accepts a reasonably nested rule tree", () => {
    expect(() => assertRuleGroupSize(buildDeeplyNested(5))).not.toThrow();
  });

  it("rejects a rule tree nested far deeper than any real segment builder would produce", () => {
    // Protects against a pathological JSON body exhausting the call stack in
    // Zod's own recursive parsing or compile.ts's recursive descent — a real
    // segment built through the UI never nests anywhere close to this deep.
    expect(() => assertRuleGroupSize(buildDeeplyNested(50))).toThrow(/nested too deeply/);
  });

  it("rejects a rule tree with too many total conditions, even if shallow", () => {
    const wideGroup = {
      glue: "and",
      conditions: Array.from({ length: 1000 }, () => ({
        kind: "contact_field",
        field: "status",
        op: "eq",
        value: "subscribed",
      })),
    };
    expect(() => assertRuleGroupSize(wideGroup)).toThrow(/too many conditions/);
  });

  it("parseRuleGroup rejects an oversized tree before Zod ever sees it", () => {
    expect(() => parseRuleGroup(buildDeeplyNested(50))).toThrow(/nested too deeply/);
  });
});
