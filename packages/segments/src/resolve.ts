import { count as countAll } from "drizzle-orm";
import { db, getSegmentById, schema } from "@carnival/db";
import { compileSegmentWhere } from "./compile.js";
import { parseRuleGroup, type RuleGroup } from "./types.js";

export async function resolveSegmentContactIds(segmentId: number): Promise<number[]> {
  const segment = await getSegmentById(segmentId);
  if (!segment) {
    throw new Error(`segment ${segmentId} not found`);
  }

  const rule = parseRuleGroup(segment.definition);
  const where = compileSegmentWhere(rule);
  const rows = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(where);
  return rows.map((row) => row.id);
}

/** Counts contacts matching a rule tree that hasn't been saved as a segment
 * yet — powers the segment builder's live "N contactos" preview, where a
 * COUNT(*) is cheaper than fetching every matching id like the function
 * above does for an already-saved segment. */
export async function countContactsMatchingRule(rule: RuleGroup): Promise<number> {
  const where = compileSegmentWhere(rule);
  const [row] = await db.select({ count: countAll() }).from(schema.contacts).where(where);
  return row?.count ?? 0;
}

export interface SegmentContactRow {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
}

/** For "who's actually in this segment" — a real question with no answer
 * anywhere in the UI before this (only the live count existed). Ordered by
 * id for a stable, deterministic page boundary — a segment resolved from
 * order/event data has no natural "recency" column of its own to sort by. */
export async function resolveSegmentContactsPage(
  segmentId: number,
  { limit, offset }: { limit: number; offset: number },
): Promise<{ contacts: SegmentContactRow[]; total: number }> {
  const segment = await getSegmentById(segmentId);
  if (!segment) {
    throw new Error(`segment ${segmentId} not found`);
  }

  const rule = parseRuleGroup(segment.definition);
  const where = compileSegmentWhere(rule);
  const [contacts, [{ count: total }]] = await Promise.all([
    db
      .select({
        id: schema.contacts.id,
        email: schema.contacts.email,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        status: schema.contacts.status,
      })
      .from(schema.contacts)
      .where(where)
      .orderBy(schema.contacts.id)
      .limit(limit)
      .offset(offset),
    db.select({ count: countAll() }).from(schema.contacts).where(where),
  ]);
  return { contacts, total };
}
