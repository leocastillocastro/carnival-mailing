import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { segments } from "../schema.js";

export interface SegmentInput {
  name: string;
  definition: unknown;
}

export async function getAllSegments() {
  return db.select().from(segments).orderBy(segments.name);
}

export async function getSegmentById(id: number) {
  const [row] = await db.select().from(segments).where(eq(segments.id, id)).limit(1);
  return row ?? null;
}

export async function createSegment(input: SegmentInput) {
  const [row] = await db.insert(segments).values(input).returning();
  return row;
}

export async function updateSegment(id: number, input: SegmentInput) {
  const [row] = await db
    .update(segments)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(segments.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSegment(id: number) {
  await db.delete(segments).where(eq(segments.id, id));
}
