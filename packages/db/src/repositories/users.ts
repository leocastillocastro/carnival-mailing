import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { normalizeEmail } from "../normalizeEmail.js";
import { users } from "../schema.js";

export async function createUser(email: string, passwordHash: string) {
  const [row] = await db.insert(users).values({ email: normalizeEmail(email), passwordHash }).returning();
  return row;
}

export async function findUserByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return row ?? null;
}
