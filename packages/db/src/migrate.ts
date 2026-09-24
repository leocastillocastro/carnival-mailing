import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

await migrate(db, { migrationsFolder: "./migrations" });
await pool.end();
console.log("Migrations applied");
