CREATE TYPE "public"."run_stage" AS ENUM('metrics', 'fetch', 'extract', 'toppages', 'judge', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."service_tier" AS ENUM('batch', 'standard');--> statement-breakpoint
CREATE TYPE "public"."site_status" AS ENUM('pending', 'prefail', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('manipulation', 'bad', 'meh', 'good', 'excellent');--> statement-breakpoint
CREATE TABLE "metrics_cache" (
	"domain" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"domain_rating" integer,
	"organic_traffic" integer,
	"organic_keywords" integer,
	"refdomains_dofollow" integer,
	"linked_domains_dofollow" integer,
	"top_pages" jsonb,
	"top_pages_fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stage" "run_stage" DEFAULT 'metrics' NOT NULL,
	"service_tier" "service_tier" DEFAULT 'batch' NOT NULL,
	"thresholds" jsonb NOT NULL,
	"extract_batch_id" text,
	"judge_batch_id" text,
	"input_count" integer DEFAULT 0 NOT NULL,
	"rejected_inputs" jsonb,
	"ahrefs_units" integer DEFAULT 0 NOT NULL,
	"error" text,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"status" "site_status" DEFAULT 'pending' NOT NULL,
	"domain_rating" integer,
	"organic_traffic" integer,
	"organic_keywords" integer,
	"refdomains_dofollow" integer,
	"linked_domains_dofollow" integer,
	"out_in_ratio" numeric(10, 3),
	"prefail_reason" text,
	"fetch_error" text,
	"description" text,
	"language" text,
	"audience_country" text,
	"site_type" text,
	"taxonomy" jsonb,
	"specific_niche" text,
	"topic_breadth" text,
	"profile_confidence" numeric(4, 3),
	"top_pages" jsonb,
	"coverage" numeric(5, 4),
	"branded_share" numeric(5, 4),
	"ranks_for_almost_nothing" boolean,
	"verdict" "verdict",
	"raw_verdict" "verdict",
	"niche_mismatch" boolean,
	"niche_penalty_applied" boolean,
	"entity_recognition" text,
	"entity_note" text,
	"reason" text,
	"error" text,
	"checked_at" timestamp with time zone,
	"human_verdict" "verdict",
	"human_reason" text
);
--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metrics_cache_fetched_idx" ON "metrics_cache" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_run_domain_idx" ON "sites" USING btree ("run_id","domain");--> statement-breakpoint
CREATE INDEX "sites_run_status_idx" ON "sites" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "sites_verdict_idx" ON "sites" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "sites_domain_checked_idx" ON "sites" USING btree ("domain","checked_at");