import {
  and,
  eq,
  exists,
  gt,
  gte,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, schema } from "@carnival/db";
import type { Condition, Op, RuleGroup } from "./types.js";

const { contacts, contactLists, orders, orderItems, events } = schema;

/** Fixed allowlist of queryable contact columns — `field` from the JSON
 * definition is only ever used as a *key into this map*, never interpolated
 * into SQL, so an unrecognized field throws here instead of reaching the DB. */
const contactFieldColumns: Record<"status" | "email" | "createdAt", AnyPgColumn> = {
  status: contacts.status,
  email: contacts.email,
  createdAt: contacts.createdAt,
};

function andAll(conditions: SQL[]): SQL {
  // Safe to assert: `and()` only returns undefined when called with zero
  // arguments, and every caller here always passes at least one condition.
  return and(...conditions)!;
}

function orAll(conditions: SQL[]): SQL {
  return or(...conditions)!;
}

/** value is `unknown` from the JSON definition, validated by zod at the shape
 * level (types.ts) but not against the target column's type — the `as never`
 * casts below only relax the TS overload picked, they don't change what gets
 * sent to Postgres: every branch still goes through drizzle's parameterized
 * comparison functions, never string concatenation. */
/** Escapes LIKE's own metacharacters (%, _, and the escape character itself)
 * in a user-supplied "contains" value — otherwise searching for a literal
 * "50%" silently matches anything containing "50" (the % is read as a
 * wildcard), producing a broader audience than the segment author intended.
 * Postgres's LIKE defaults to `\` as its escape character with no ESCAPE
 * clause needed. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function compareOp(left: AnyPgColumn | SQL, op: Op, value: unknown): SQL {
  switch (op) {
    case "eq":
      return eq(left as never, value as never);
    case "neq":
      return ne(left as never, value as never);
    case "gt":
      return gt(left as never, value as never);
    case "gte":
      return gte(left as never, value as never);
    case "lt":
      return lt(left as never, value as never);
    case "lte":
      return lte(left as never, value as never);
    case "contains":
      return like(left as never, `%${escapeLikePattern(String(value))}%`);
    case "isEmpty":
      return orAll([isNull(left as never), eq(left as never, "" as never)]);
    case "isNotEmpty":
      return andAll([isNotNull(left as never), ne(left as never, "" as never)]);
  }
}

function withinDaysCondition(column: AnyPgColumn, days: number): SQL {
  return sql`${column} >= now() - (${days} || ' days')::interval`;
}

function compileContactField(condition: Extract<Condition, { kind: "contact_field" }>): SQL {
  const column = contactFieldColumns[condition.field];
  if (condition.withinDays) {
    return withinDaysCondition(column, condition.withinDays);
  }
  const value =
    condition.field === "createdAt" && typeof condition.value === "string"
      ? new Date(condition.value)
      : condition.value;
  return compareOp(column, condition.op, value);
}

function compileContactAttribute(condition: Extract<Condition, { kind: "contact_attribute" }>): SQL {
  // path is bound as a parameter to `->>`, never interpolated into the SQL text.
  const expr = sql`${contacts.attributes} ->> ${condition.path}`;
  return compareOp(expr, condition.op, condition.value);
}

function compileListMembership(condition: Extract<Condition, { kind: "list_membership" }>): SQL {
  const conditions: SQL[] = [eq(contactLists.contactId, contacts.id), eq(contactLists.listId, condition.listId)];
  if (condition.status) conditions.push(eq(contactLists.status, condition.status));
  const subquery = db.select({ one: sql`1` }).from(contactLists).where(andAll(conditions));
  return exists(subquery);
}

function compileOrderExists(condition: Extract<Condition, { kind: "order_exists" }>): SQL {
  const orderConditions: SQL[] = [eq(orders.contactId, contacts.id)];
  if (condition.status) orderConditions.push(eq(orders.status, condition.status));
  if (condition.shippingMethod) orderConditions.push(eq(orders.shippingMethod, condition.shippingMethod));
  if (condition.withinDays) orderConditions.push(withinDaysCondition(orders.createdAt, condition.withinDays));

  const query = db.select({ one: sql`1` }).from(orders);
  const subquery =
    condition.category || condition.sku
      ? query
          .innerJoin(
            orderItems,
            andAll([
              eq(orderItems.orderId, orders.id),
              ...(condition.category ? [eq(orderItems.category, condition.category)] : []),
              ...(condition.sku ? [eq(orderItems.sku, condition.sku)] : []),
            ]),
          )
          .where(andAll(orderConditions))
      : query.where(andAll(orderConditions));

  return condition.op === "any" ? exists(subquery) : notExists(subquery);
}

function compileEventExists(condition: Extract<Condition, { kind: "event_exists" }>): SQL {
  const conditions: SQL[] = [eq(events.contactId, contacts.id), eq(events.type, condition.type)];
  if (condition.campaignId) conditions.push(eq(events.campaignId, condition.campaignId));
  if (condition.withinDays) conditions.push(withinDaysCondition(events.occurredAt, condition.withinDays));
  const subquery = db.select({ one: sql`1` }).from(events).where(andAll(conditions));
  return condition.op === "any" ? exists(subquery) : notExists(subquery);
}

function compileCondition(condition: Condition | RuleGroup): SQL {
  if ("glue" in condition) return compileRuleGroup(condition);
  switch (condition.kind) {
    case "contact_field":
      return compileContactField(condition);
    case "contact_attribute":
      return compileContactAttribute(condition);
    case "list_membership":
      return compileListMembership(condition);
    case "order_exists":
      return compileOrderExists(condition);
    case "event_exists":
      return compileEventExists(condition);
  }
}

function compileRuleGroup(rule: RuleGroup): SQL {
  const compiled = rule.conditions.map(compileCondition);
  return rule.glue === "and" ? andAll(compiled) : orAll(compiled);
}

/** A contact tagged `attributes.internal = "true"` is a staff/business
 * account used to place real WooCommerce orders (the shop's own account for
 * phone-in orders, the owner's personal account) — never a real marketing
 * subscriber, no matter what a segment's own conditions say about them.
 * ANDed onto every compiled segment here, at the one place all segment
 * resolution goes through, so no segment — current or future, however it
 * defines its own audience — can accidentally target one of these accounts
 * just because its definition doesn't happen to exclude them. */
function excludeInternalContacts(where: SQL): SQL {
  return andAll([where, sql`${contacts.attributes} ->> 'internal' IS DISTINCT FROM 'true'`]);
}

export function compileSegmentWhere(rule: RuleGroup): SQL {
  return excludeInternalContacts(compileRuleGroup(rule));
}
