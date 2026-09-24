import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const contactStatusEnum = pgEnum("contact_status", [
  "subscribed",
  "unsubscribed",
  "bounced",
  "complained",
]);

export const optinEnum = pgEnum("optin", ["single", "double"]);

export const listMembershipStatusEnum = pgEnum("list_membership_status", [
  "subscribed",
  "unsubscribed",
  "pending",
]);

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "paused",
]);

export const sendStatusEnum = pgEnum("send_status", [
  "queued",
  "sending",
  "sent",
  "failed",
  "bounced",
  "suppressed",
  "complained",
]);

export const eventTypeEnum = pgEnum("event_type", [
  "open",
  "click",
  "bounce",
  "complaint",
  "unsubscribe",
]);

export const suppressionReasonEnum = pgEnum("suppression_reason", [
  "unsubscribe",
  "bounce",
  "complaint",
  "manual",
]);

// "processing" is the atomic claim state: a webhook handler transitions a
// delivery id into it before doing any side effects, so a second concurrent
// delivery of the same id (WooCommerce/SNS retries, or a replayed signed
// request) can't slip through the same check-then-act race a plain
// exists-check would have. See claimDelivery in repositories/syncLog.ts.
export const syncStatusEnum = pgEnum("sync_status", ["processing", "processed", "failed"]);

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  wooCustomerId: integer("woo_customer_id"),
  status: contactStatusEnum("status").notNull().default("subscribed"),
  attributes: jsonb("attributes").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("contacts_email_idx").on(table.email),
  uniqueIndex("contacts_woo_customer_id_idx").on(table.wooCustomerId),
]);

export const lists = pgTable("lists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  optin: optinEnum("optin").notNull().default("single"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("lists_name_idx").on(table.name)]);

export const contactLists = pgTable("contact_lists", {
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  listId: integer("list_id").notNull().references(() => lists.id, { onDelete: "cascade" }),
  status: listMembershipStatusEnum("status").notNull().default("subscribed"),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.contactId, table.listId] }),
]);

export const segments = pgTable("segments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  isDynamic: boolean("is_dynamic").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  wooOrderId: integer("woo_order_id").notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  total: numeric("total", { precision: 10, scale: 2 }),
  currency: varchar("currency", { length: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // WooCommerce's method_id ("free_shipping", "flat_rate", "local_pickup" in
  // this store) — see packages/woocommerce/src/mappers.ts.
  shippingMethod: text("shipping_method"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("orders_woo_order_id_idx").on(table.wooOrderId)]);

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  wooProductId: integer("woo_product_id"),
  productName: text("product_name").notNull(),
  sku: text("sku"),
  category: text("category"),
  quantity: integer("quantity").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
});

export const templates = pgTable("templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  htmlContent: text("html_content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  templateId: integer("template_id").references(() => templates.id),
  // Fills the template's own {{campaign.*}} merge tags (title, promo text,
  // price, dates...) — the per-send content a template author leaves as
  // variable slots, distinct from {{contact.*}} which varies per recipient.
  // See extractCampaignFieldNames in packages/templates for how the admin
  // form knows which fields to show for a given template.
  contentFields: jsonb("content_fields").notNull().default({}),
  listId: integer("list_id").references(() => lists.id),
  segmentId: integer("segment_id").references(() => segments.id),
  status: campaignStatusEnum("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaignSends = pgTable("campaign_sends", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  status: sendStatusEnum("status").notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  trackingToken: text("tracking_token").notNull(),
  // Set when claimCampaignSendForSending transitions queued -> sending — the
  // reconciliation safety net (reapStuckSends) uses this to find a row stuck
  // at "sending" long enough that whatever worker claimed it is presumed
  // gone (crashed, or a BullMQ job that failed before its own retries were
  // exhausted — see moveStalledJobsToWait's maxStalledCount behavior). Kept
  // separate from sentAt, which only means "actually sent".
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
}, (table) => [
  uniqueIndex("campaign_sends_campaign_contact_idx").on(table.campaignId, table.contactId),
  uniqueIndex("campaign_sends_tracking_token_idx").on(table.trackingToken),
]);

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sendId: bigint("send_id", { mode: "number" }).references(() => campaignSends.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  type: eventTypeEnum("type").notNull(),
  url: text("url"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suppressions = pgTable("suppressions", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  reason: suppressionReasonEnum("reason").notNull(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("suppressions_email_idx").on(table.email)]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("users_email_idx").on(table.email)]);

export const sessions = pgTable("sessions", {
  // A SHA-256 hash of the session token, never the raw token itself — see
  // packages/db/src/repositories/sessions.ts.
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncLog = pgTable("sync_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  source: text("source").notNull(),
  eventType: text("event_type").notNull(),
  externalId: text("external_id"),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  status: syncStatusEnum("status").notNull().default("processed"),
}, (table) => [
  uniqueIndex("sync_log_source_external_id_idx").on(table.source, table.externalId),
]);
