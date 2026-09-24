import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "../client.js";
import { sessions, users } from "../schema.js";

// Same 7-day window Listmonk uses for its Postgres-backed sessions table.
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** `sessions.token` stores this hash, never the raw token — same reasoning as
 * hashing passwords: a DB read (backup leak, misconfigured replica, a future
 * bug elsewhere) shouldn't hand over a directly usable session. A fast hash
 * (not scrypt) is fine here, unlike passwords: the input is already a 32-byte
 * random value, not something guessable, so there's nothing for a slow hash
 * to protect against. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await db.insert(sessions).values({ token: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export interface SessionUser {
  userId: number;
  email: string;
}

export async function getSessionUser(token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({ userId: users.id, email: users.email, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, hashToken(token)))
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return { userId: row.userId, email: row.email };
}

export async function destroySession(token: string) {
  await db.delete(sessions).where(eq(sessions.token, hashToken(token)));
}

export async function pruneExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
