// Must load before @carnival/db is imported below — its client.ts reads
// DATABASE_URL from process.env at module-evaluation time.
import "dotenv/config";
import { createUser, findUserByEmail, pool } from "@carnival/db";
import { hashPassword } from "../src/auth.js";

// `pnpm --filter @carnival/admin createUser -- <email> <password>` forwards
// the literal "--" through to argv instead of stripping it, which used to
// shift email/password off by one (email became "--").
const [email, password] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!email || !password) {
  console.error("usage: pnpm createUser -- <email> <password>");
  process.exit(1);
}

async function main() {
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new Error(`user ${email} already exists`);
  }
  const passwordHash = await hashPassword(password);
  const user = await createUser(email, passwordHash);
  console.log(`created user ${user.email} (id ${user.id})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
