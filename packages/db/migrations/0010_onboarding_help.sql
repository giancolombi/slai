-- In-product onboarding and help: per-user, per-org checklist dismissal and first-run welcome.

CREATE TABLE "onboarding_state" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"checklist_dismissed_at" timestamp with time zone,
	"welcome_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_state_org_id_user_id_unique" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Everyone who is already a member has used slai: they never get the first-run welcome.
-- (Before RLS is enabled, so the backfill sees every membership.)
INSERT INTO onboarding_state (org_id, user_id, welcome_seen_at)
SELECT org_id, user_id, now() FROM memberships
ON CONFLICT (org_id, user_id) DO NOTHING;
--> statement-breakpoint
-- The app role reads and writes a user's own preferences through withOrg (RLS by org;
-- the API filters by the session's user). No other role needs this table.
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_state TO slai_app;
--> statement-breakpoint
ALTER TABLE onboarding_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE onboarding_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON onboarding_state
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
