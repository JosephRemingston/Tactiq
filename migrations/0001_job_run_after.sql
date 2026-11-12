ALTER TABLE "ingestion_jobs" ADD COLUMN "priority" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD COLUMN "run_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ingestion_jobs_claim_idx" ON "ingestion_jobs" USING btree ("status","run_after","priority");