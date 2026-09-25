// Must load before @carnival/db is imported below — its client.ts reads
// DATABASE_URL from process.env at module-evaluation time.
import "dotenv/config";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createUser, findUserByEmail, pool } from "@carnival/db";
import { hashPassword } from "../src/auth.js";

// `pnpm --filter @carnival/admin createUser -- <email>` forwards the literal
// "--" through to argv instead of stripping it, which used to shift the
// arguments off by one (email became "--").
const args = process.argv.slice(2).filter((arg) => arg !== "--");
// The password is deliberately not accepted as an argument: it would end up
// in shell history and be visible to anyone listing processes.
if (args.length !== 1) {
  console.error("usage: pnpm createUser -- <email>   (the password is prompted for)");
  process.exit(1);
}
const [email] = args;

// Readline echoes every keystroke through its output stream when stdin is a
// TTY — routing that through a stream that can be muted is what hides the
// password without a dependency. Piped stdin (no TTY) still works, one line
// per prompt.
let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
// In raw mode Ctrl+C reaches readline instead of the process, and with no
// listener readline just pauses — which would leave the script hanging.
rl.on("SIGINT", () => {
  process.stdout.write("\n");
  process.exit(130);
});
// The async iterator buffers lines, unlike rl.question(), which drops a
// piped line that arrives before the next question is asked.
const lines = rl[Symbol.asyncIterator]();

async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  muted = true;
  const { value, done } = await lines.next();
  muted = false;
  process.stdout.write("\n");
  if (done) throw new Error("no password given");
  return value;
}

async function main() {
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new Error(`user ${email} already exists`);
  }
  const password = await promptHidden("Password: ");
  if (!password) {
    throw new Error("password must not be empty");
  }
  if ((await promptHidden("Repeat password: ")) !== password) {
    throw new Error("passwords do not match");
  }
  rl.close();
  const passwordHash = await hashPassword(password);
  const user = await createUser(email, passwordHash);
  console.log(`created user ${user.email} (id ${user.id})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
