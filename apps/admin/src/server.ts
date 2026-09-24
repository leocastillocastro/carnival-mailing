// Must load before ./app.js is imported below — its route files import
// @carnival/db, which reads DATABASE_URL from process.env at module-evaluation
// time, before ./env.js's own "dotenv/config" import would otherwise run.
import "dotenv/config";
import { pruneExpiredSessions } from "@carnival/db";
import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Nothing else ever deletes an expired session row — without this they just
// accumulate forever. Once at startup plus once a day is more than enough
// for a single-operator LAN tool with, at most, a handful of sessions ever
// open at once; not worth a real job queue entry for.
const PRUNE_SESSIONS_INTERVAL_MS = 24 * 60 * 60 * 1000;
function pruneSessions() {
  pruneExpiredSessions().catch((err) => app.log.error(err, "failed to prune expired sessions"));
}
pruneSessions();
setInterval(pruneSessions, PRUNE_SESSIONS_INTERVAL_MS);
