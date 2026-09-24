// Integration tests against a real Postgres — they need
// `docker compose -f infra/docker-compose.yml up -d` running locally and
// packages/segments/.env pointing DATABASE_URL at it.
import "dotenv/config";
import { afterAll } from "vitest";
import { pool } from "@carnival/db";

afterAll(async () => {
  await pool.end();
});
