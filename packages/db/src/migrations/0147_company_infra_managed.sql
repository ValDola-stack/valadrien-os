-- Fork migration: ValAdrien Cloud managed-infra feature (regenerated during
-- the 2026-07-13 upstream sync; original fork migrations 0090-0092 are
-- preserved in scripts/sync/fork-migrations-backup/).
--
-- IDEMPOTENT ON PURPOSE: databases created by the pre-sync fork already have
-- all of these objects (applied as old 0090-0092), while fresh installs and
-- upstream-migrated databases have none. IF NOT EXISTS / ON CONFLICT guards
-- make this migration safe in both worlds.
CREATE TABLE IF NOT EXISTS "company_infra_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"mode" text DEFAULT 'managed_shared' NOT NULL,
	"status" text DEFAULT 'entitled' NOT NULL,
	"provider" text,
	"binding_ref" text,
	"provisioned_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "website_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "founder_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "infra_mode" text DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "instruction_bundle" jsonb;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_infra_entitlements_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "company_infra_entitlements"
      ADD CONSTRAINT "company_infra_entitlements_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_infra_entitlements_company_idx" ON "company_infra_entitlements" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_infra_entitlements_company_capability_uq" ON "company_infra_entitlements" USING btree ("company_id","capability");--> statement-breakpoint
-- Seed default ValAdrien Cloud entitlements for managed companies that
-- pre-date the entitlements table. Idempotent via ON CONFLICT.
INSERT INTO "company_infra_entitlements" (
  "company_id",
  "capability",
  "mode",
  "status"
)
SELECT
  companies."id",
  defaults."capability",
  defaults."mode",
  'entitled'
FROM "companies"
CROSS JOIN (
  VALUES
    ('postgres', 'managed_shared'),
    ('email', 'managed_shared'),
    ('llm', 'managed_shared'),
    ('hosting', 'managed_dedicated'),
    ('worker', 'managed_shared')
) AS defaults("capability", "mode")
WHERE companies."infra_mode" = 'managed'
ON CONFLICT ("company_id", "capability") DO NOTHING;
