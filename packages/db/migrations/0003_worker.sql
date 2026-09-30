ALTER TABLE "connections" ADD COLUMN "mapping_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- The timer sweep (systemDb) claims due tickets with FOR UPDATE SKIP LOCKED and
-- leases them by pushing next_check_at forward. Row locks need UPDATE, so grant
-- it on that one scheduling column only.
GRANT UPDATE (next_check_at) ON tickets TO slai_worker;
