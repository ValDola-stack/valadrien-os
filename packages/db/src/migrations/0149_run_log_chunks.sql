-- DB-backed run-log transcript chunks.
--
-- Reconciled onto the sync lineage from the unmerged branch feat/db-backed-run-logs
-- (original migration 0093, renumbered here to 0149). Fixes "Run log not found": the Railway
-- worker wrote run logs to a local filesystem the Vercel control plane cannot read,
-- so every transcript 404'd. Both planes share this database.
--
-- IDEMPOTENT ON PURPOSE, matching the house style of the other fork migrations
-- (see 0147): safe to re-run against a database that already has the objects.
CREATE TABLE IF NOT EXISTS "heartbeat_run_log_chunks" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'heartbeat_run_log_chunks_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "heartbeat_run_log_chunks"
      ADD CONSTRAINT "heartbeat_run_log_chunks_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'heartbeat_run_log_chunks_run_id_heartbeat_runs_id_fk'
  ) THEN
    ALTER TABLE "heartbeat_run_log_chunks"
      ADD CONSTRAINT "heartbeat_run_log_chunks_run_id_heartbeat_runs_id_fk"
      FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_log_chunks_run_seq_idx" ON "heartbeat_run_log_chunks" USING btree ("run_id","seq");
