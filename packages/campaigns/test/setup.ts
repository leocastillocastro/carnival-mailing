// Integration tests against a real Postgres — need
// `docker compose -f infra/docker-compose.yml up -d` running locally.
import "dotenv/config";
import { afterAll } from "vitest";
import { pool } from "@carnival/db";

afterAll(async () => {
  await pool.end();
});
