CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'paused');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('subscribed', 'unsubscribed', 'bounced', 'complained');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('open', 'click', 'bounce', 'complaint', 'unsubscribe');--> statement-breakpoint
CREATE TYPE "public"."list_membership_status" AS ENUM('subscribed', 'unsubscribed', 'pending');--> statement-breakpoint
CREATE TYPE "public"."optin" AS ENUM('single', 'double');--> statement-breakpoint
CREATE TYPE "public"."send_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribe', 'bounce', 'complaint', 'manual');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('processed', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_sends" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"status" "send_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"tracking_token" text NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"from_name" text NOT NULL,
	"from_email" text NOT NULL,
	"template_id" integer,
	"list_id" integer,
	"segment_id" integer,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_lists" (
	"contact_id" integer NOT NULL,
	"list_id" integer NOT NULL,
	"status" "list_membership_status" DEFAULT 'subscribed' NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_lists_contact_id_list_id_pk" PRIMARY KEY("contact_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"woo_customer_id" integer,
	"status" "contact_status" DEFAULT 'subscribed' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"send_id" bigint,
	"contact_id" integer NOT NULL,
	"campaign_id" integer,
	"type" "event_type" NOT NULL,
	"url" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"optin" "optin" DEFAULT 'single' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"woo_product_id" integer,
	"product_name" text NOT NULL,
	"sku" text,
	"category" text,
	"quantity" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"woo_order_id" integer NOT NULL,
	"contact_id" integer,
	"status" text NOT NULL,
	"total" numeric(10, 2),
	"currency" varchar(3),
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"is_dynamic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text,
	"payload" jsonb,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "sync_status" DEFAULT 'processed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"html_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_send_id_campaign_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."campaign_sends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_campaign_contact_idx" ON "campaign_sends" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_tracking_token_idx" ON "campaign_sends" USING btree ("tracking_token");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_woo_customer_id_idx" ON "contacts" USING btree ("woo_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lists_name_idx" ON "lists" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_woo_order_id_idx" ON "orders" USING btree ("woo_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_idx" ON "suppressions" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_log_source_external_id_idx" ON "sync_log" USING btree ("source","external_id");