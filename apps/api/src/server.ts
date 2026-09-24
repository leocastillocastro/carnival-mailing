// Must load before ./app.js is imported below — its route files import
// @carnival/db, which reads DATABASE_URL from process.env at module-evaluation
// time, before ./env.js's own "dotenv/config" import would otherwise run.
import "dotenv/config";
import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
