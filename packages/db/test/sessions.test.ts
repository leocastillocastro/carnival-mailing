import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/client.js";
import { createSession, destroySession, getSessionUser } from "../src/repositories/sessions.js";
import { createUser } from "../src/repositories/users.js";
import { sessions, users } from "../src/schema.js";

const email = "audit-test-sessions@example.com";
let userId: number;

afterEach(async () => {
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.email, email));
});

async function seedUser() {
  const user = await createUser(email, "irrelevant-hash");
  userId = user.id;
  return user;
}

describe("sessions repository", () => {
  it("round-trips: a token from createSession resolves via getSessionUser", async () => {
    const user = await seedUser();
    const { token } = await createSession(user.id);

    const resolved = await getSessionUser(token);
    expect(resolved).toEqual({ userId: user.id, email });
  });

  it("never stores the raw token — the DB row holds a hash instead", async () => {
    const user = await seedUser();
    const { token } = await createSession(user.id);

    const [row] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(row.token).not.toBe(token);
    expect(row.token).toHaveLength(64); // hex-encoded sha256
  });

  it("returns null for a token that was never issued", async () => {
    expect(await getSessionUser("not-a-real-token")).toBeNull();
  });

  it("destroySession removes the session so the token stops resolving", async () => {
    const user = await seedUser();
    const { token } = await createSession(user.id);

    await destroySession(token);

    expect(await getSessionUser(token)).toBeNull();
  });
});
