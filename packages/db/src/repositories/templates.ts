import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { templates } from "../schema.js";

export interface TemplateInput {
  name: string;
  htmlContent: string;
}

export async function getAllTemplates() {
  return db.select().from(templates).orderBy(templates.name);
}

export async function getTemplateById(id: number) {
  const [row] = await db.select().from(templates).where(eq(templates.id, id)).limit(1);
  return row ?? null;
}

export async function createTemplate(input: TemplateInput) {
  const [row] = await db.insert(templates).values(input).returning();
  return row;
}

export async function updateTemplate(id: number, input: TemplateInput) {
  const [row] = await db
    .update(templates)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(templates.id, id))
    .returning();
  return row ?? null;
}

export async function deleteTemplate(id: number) {
  await db.delete(templates).where(eq(templates.id, id));
}
