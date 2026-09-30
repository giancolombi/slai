CREATE TYPE "public"."billing_status" AS ENUM('trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan" text NOT NULL,
	"tracked_tickets" integer DEFAULT 0 NOT NULL,
	"tracked_limit" integer,
	"ticket_overage" integer DEFAULT 0 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"included_credits" integer DEFAULT 0 NOT NULL,
	"purchased_credits_used" integer DEFAULT 0 NOT NULL,
	"credit_overage" integer DEFAULT 0 NOT NULL,
	"overage_cents" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_org_id_period_start_unique" UNIQUE("org_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"source" text NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"stripe_checkout_session_id" text,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "plan" SET DEFAULT 'growth';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_status" "billing_status" DEFAULT 'trialing' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trial_ends_at" timestamp with time zone DEFAULT now() + interval '14 days';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_grants_org_id_created_at_index" ON "credit_grants" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_stripe_customer_id_unique" UNIQUE("stripe_customer_id");
--> statement-breakpoint
-- The old default plan "trial" is now the Growth trial (billing_status 'trialing').
UPDATE "organizations" SET "plan" = 'growth' WHERE "plan" = 'trial';
--> statement-breakpoint
-- slai_app: billing periods are refreshed in place; grants and processed events are append-only.
GRANT SELECT, INSERT, UPDATE ON billing_periods TO slai_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON credit_grants, billing_events TO slai_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_periods', 'credit_grants', 'billing_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER credit_grants_append_only BEFORE UPDATE OR DELETE ON credit_grants
  FOR EACH ROW EXECUTE FUNCTION slai_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_grants_no_truncate BEFORE TRUNCATE ON credit_grants
  FOR EACH STATEMENT EXECUTE FUNCTION slai_reject_mutation();