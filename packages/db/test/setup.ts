// These are integration tests against a real Postgres — they need
// `docker compose -f infra/docker-compose.yml up -d` running locally and
// packages/db/.env pointing DATABASE_URL at it.
import "dotenv/config";
import { afterAll } from "vitest";
import { pool } from "../src/client.js";

afterAll(async () => {
  await pool.end();
});
