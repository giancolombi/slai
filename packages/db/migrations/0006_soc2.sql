CREATE TABLE "org_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"size_bytes" bigint,
	"sha256" text,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_exports" ADD CONSTRAINT "org_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_exports" ADD CONSTRAINT "org_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_exports_org_id_index" ON "org_exports" USING btree ("org_id");
--> statement-breakpoint

-- ---------- T-63/T-64 hand-written: grants, RLS, retention and offboarding ----------
-- Rate-limit buckets are disposable: unlogged (no WAL, not replicated, emptied after a crash).
ALTER TABLE rate_limit_buckets SET UNLOGGED;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO slai_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_exports TO slai_app;
--> statement-breakpoint
ALTER TABLE org_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON org_exports
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

-- Hard delete of an organization after its grace period. The database enforces
-- the grace: only an org whose deletion_scheduled_for has passed is deleted,
-- whoever calls. Every org table cascades from organizations; the append-only
-- audit_events and usage_ledger have no foreign key to it, so the audit trail and
-- billing records survive. SECURITY DEFINER so slai_worker, which holds no
-- DELETE grant on org data, can run exactly this and nothing more.
CREATE OR REPLACE FUNCTION slai_delete_org(p_org uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  -- FORCE RLS applies to the table owner on managed Postgres (not a superuser there).
  PERFORM set_config('app.org_id', p_org::text, true);
  DELETE FROM organizations
    WHERE id = p_org AND deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION slai_delete_org(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION slai_delete_org(uuid) TO slai_worker;
--> statement-breakpoint

-- Purges expired auth state: sessions, verification tokens (better-auth's
-- `verifications`, when that table exists) and idle rate-limit buckets. Checks
-- which auth tables exist, so it keeps working as the auth schema changes.
CREATE OR REPLACE FUNCTION slai_purge_expired_auth() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s integer := 0; v integer := 0; r integer := 0;
BEGIN
  IF to_regclass('public.sessions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM sessions WHERE expires_at < now()';
    GET DIAGNOSTICS s = ROW_COUNT;
  END IF;
  IF to_regclass('public.verifications') IS NOT NULL THEN
    EXECUTE 'DELETE FROM verifications WHERE expires_at < now()';
    GET DIAGNOSTICS v = ROW_COUNT;
  END IF;
  DELETE FROM rate_limit_buckets WHERE updated_at < now() - interval '1 day';
  GET DIAGNOSTICS r = ROW_COUNT;
  RETURN jsonb_build_object('sessions', s, 'verifications', v, 'rateLimitBuckets', r);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION slai_purge_expired_auth() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION slai_purge_expired_auth() TO slai_worker;