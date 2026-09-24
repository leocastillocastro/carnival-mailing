import { z } from "zod";
import type { EventType } from "@carnival/db";

export const opSchema = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "isEmpty", "isNotEmpty"]);
export type Op = z.infer<typeof opSchema>;

/** Ops that don't take a value — everything else does. */
const valuelessOps = new Set<Op>(["isEmpty", "isNotEmpty"]);

function requireValueForOp(data: { op: Op; value?: unknown }, ctx: z.RefinementCtx) {
  if (!valuelessOps.has(data.op) && data.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `op "${data.op}" requires a value`, path: ["value"] });
  }
}

// satisfies-style check without importing the enum values twice: this array
// must stay in sync with @carnival/db's EventType, TS will fail to compile
// this file if it drifts.
const eventTypes = ["open", "click", "bounce", "complaint", "unsubscribe"] as const satisfies readonly EventType[];
export const eventTypeSchema = z.enum(eventTypes);

// contacts.status is a fixed Postgres enum — compile.ts's compareOp() has no
// valid SQL operator for "contains"/"gt"/"gte"/"lt"/"lte" against it (Postgres
// rejects them at query time: `operator does not exist: contact_status ~~
// text`). Equality and presence are the only comparisons that make sense.
const STATUS_OPS = new Set<Op>(["eq", "neq", "isEmpty", "isNotEmpty"]);

const contactFieldSchema = z
  .object({
    kind: z.literal("contact_field"),
    field: z.enum(["status", "email", "createdAt"]),
    op: opSchema,
    value: z.unknown().optional(),
    // Rolling window (e.g. "createdAt in the last 30 days"), same idea as
    // order_exists/event_exists's withinDays — a fixed value here would go
    // stale, always matching whatever was true on the day the segment was
    // saved instead of staying "recent" as time passes. When set, this
    // replaces op/value for the comparison (op is still required by the
    // schema, but ignored at compile time).
    withinDays: z.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    // Only "createdAt" is ever compiled as a rolling window (compile.ts
    // checks `condition.withinDays` alone, not which field it's on) — a
    // stale value left over from switching away from "createdAt" would
    // silently replace whatever op/value was meant for the new field.
    if (data.withinDays !== undefined && data.field !== "createdAt") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `withinDays only applies to field "createdAt", not "${data.field}"`,
        path: ["withinDays"],
      });
    }
    if (data.field === "status" && !STATUS_OPS.has(data.op)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `op "${data.op}" isn't valid for field "status" — only ${[...STATUS_OPS].join(", ")}`,
        path: ["op"],
      });
    }
    if (data.withinDays !== undefined) return;
    requireValueForOp(data, ctx);
  });

const contactAttributeSchema = z
  .object({
    kind: z.literal("contact_attribute"),
    path: z.string().min(1),
    op: opSchema,
    value: z.unknown().optional(),
  })
  .superRefine(requireValueForOp);

const listMembershipSchema = z.object({
  kind: z.literal("list_membership"),
  listId: z.number().int().positive(),
  status: z.enum(["subscribed", "unsubscribed", "pending"]).optional(),
});

const orderExistsSchema = z.object({
  kind: z.literal("order_exists"),
  op: z.enum(["any", "none"]),
  withinDays: z.number().int().positive().optional(),
  status: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  sku: z.string().min(1).optional(),
  // WooCommerce's shipping method_id ("free_shipping", "flat_rate", "local_pickup").
  shippingMethod: z.string().min(1).optional(),
});

const eventExistsSchema = z.object({
  kind: z.literal("event_exists"),
  op: z.enum(["any", "none"]),
  type: eventTypeSchema,
  withinDays: z.number().int().positive().optional(),
  campaignId: z.number().int().positive().optional(),
});

const conditionSchema = z.union([
  contactFieldSchema,
  contactAttributeSchema,
  listMembershipSchema,
  orderExistsSchema,
  eventExistsSchema,
]);

export type Condition = z.infer<typeof conditionSchema>;

export interface RuleGroup {
  glue: "and" | "or";
  conditions: (Condition | RuleGroup)[];
}

export const ruleGroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
  z.object({
    glue: z.enum(["and", "or"]),
    conditions: z.array(z.union([conditionSchema, ruleGroupSchema])).min(1, "Agregá al menos una condición"),
  }),
);

// A real segment built through the admin UI never needs more than a handful
// of nested groups or conditions — these caps exist purely to reject a
// pathological JSON body (thousands of nested {glue, conditions} levels, or
// thousands of sibling conditions) before it can exhaust the call stack
// during Zod's own recursive parsing or compile.ts's recursive descent.
const MAX_RULE_GROUP_DEPTH = 10;
const MAX_RULE_GROUP_NODES = 500;

function checkRuleGroupSize(value: unknown, depth: number, budget: { remaining: number }): void {
  if (depth > MAX_RULE_GROUP_DEPTH) {
    throw new Error(`segment rule tree is nested too deeply (max ${MAX_RULE_GROUP_DEPTH} levels)`);
  }
  if (!value || typeof value !== "object" || !("conditions" in value) || !Array.isArray(value.conditions)) {
    return;
  }
  for (const node of value.conditions) {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      throw new Error(`segment rule tree has too many conditions/groups (max ${MAX_RULE_GROUP_NODES})`);
    }
    checkRuleGroupSize(node, depth + 1, budget);
  }
}

/** Call this on the raw parsed JSON before handing it to ruleGroupSchema
 * (whether via parseRuleGroup below or a direct `.safeParse` call) — Zod's
 * own recursive descent has no depth limit, so a pathological JSON body
 * needs to be rejected before it ever reaches the schema. */
export function assertRuleGroupSize(definition: unknown): void {
  checkRuleGroupSize(definition, 0, { remaining: MAX_RULE_GROUP_NODES });
}

export function parseRuleGroup(definition: unknown): RuleGroup {
  assertRuleGroupSize(definition);
  return ruleGroupSchema.parse(definition);
}
