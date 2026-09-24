import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({ connectionString: databaseUrl });
// pg crashes the process on an unhandled 'error' from an idle client (e.g. the
// DB restarting) unless something listens for it — this just logs it instead.
pool.on("error", (err) => {
  console.error("postgres pool error", err);
});

export const db = drizzle(pool, { schema });
