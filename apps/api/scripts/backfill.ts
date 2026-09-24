// Must load before @carnival/db is imported below — its client.ts reads
// DATABASE_URL from process.env at module-evaluation time, which happens
// before env.js's own "dotenv/config" import would otherwise run.
import "dotenv/config";
import { pool, upsertContactFromWoo, upsertOrderFromWoo } from "@carnival/db";
import { createWooClient, mapWooCustomerToContact, mapWooOrderToOrder } from "@carnival/woocommerce";
import { env } from "../src/env.js";

const client = createWooClient({
  baseUrl: env.WC_URL,
  consumerKey: env.WC_CONSUMER_KEY,
  consumerSecret: env.WC_CONSUMER_SECRET,
});

async function backfillCustomers() {
  let count = 0;
  for await (const page of client.paginateAll((params) => client.listCustomers(params))) {
    for (const customer of page) {
      await upsertContactFromWoo(mapWooCustomerToContact(customer));
      count += 1;
    }
    console.log(`contacts synced so far: ${count}`);
  }
  console.log(`done — ${count} contacts synced`);
}

async function backfillOrders() {
  let count = 0;
  // "any" excludes trashed orders but includes checkout-draft, pending, etc.
  for await (const page of client.paginateAll((params) => client.listOrders(params, "any"))) {
    for (const order of page) {
      await upsertOrderFromWoo(mapWooOrderToOrder(order));
      count += 1;
    }
    console.log(`orders synced so far: ${count}`);
  }
  console.log(`done — ${count} orders synced`);
}

async function main() {
  console.log("Backfilling customers...");
  await backfillCustomers();
  console.log("Backfilling orders...");
  await backfillOrders();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
