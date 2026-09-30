CREATE TYPE "public"."action_kind" AS ENUM('internal_note', 'public_reply', 'set_priority', 'assign');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('proposed', 'approved', 'sent', 'rejected', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "public"."agent_kind" AS ENUM('contract_extraction', 'triage', 'draft_reply');--> statement-breakpoint
CREATE TYPE "public"."alert_risk" AS ENUM('warning', 'at_risk', 'breached');--> statement-breakpoint
CREATE TYPE "public"."autonomy" AS ENUM('observe', 'assist', 'autopilot');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('email', 'slack_webhook');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'error', 'paused');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('uploaded', 'extracting', 'needs_review', 'approved', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."cycle_state" AS ENUM('running', 'paused', 'achieved', 'breached');--> statement-breakpoint
CREATE TYPE "public"."metric" AS ENUM('first_response', 'next_response', 'periodic_update', 'resolution');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('draft', 'active', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('urgent', 'high', 'normal', 'low');--> statement-breakpoint
CREATE TYPE "public"."risk" AS ENUM('ok', 'warning', 'at_risk', 'breached');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'open', 'pending', 'on_hold', 'solved', 'closed');--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"kind" "action_kind" NOT NULL,
	"status" "action_status" DEFAULT 'proposed' NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real,
	"blocked_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"external_ref" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "agent_kind" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"ticket_id" uuid,
	"contract_id" uuid,
	"model" text,
	"provider" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"sandbox_id" text,
	"sandbox_seconds" real,
	"output" jsonb,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "autonomy_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_account_id" uuid,
	"priority" "priority",
	"level" "autonomy" NOT NULL,
	"trigger_at" "alert_risk" NOT NULL,
	"min_confidence" real DEFAULT 0.8 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomy_rules_org_id_customer_account_id_priority_unique" UNIQUE NULLS NOT DISTINCT("org_id","customer_account_id","priority")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"credentials" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mapping" jsonb,
	"webhook_secret" text,
	"sync_cursor" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_account_id" uuid,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" "contract_status" DEFAULT 'uploaded' NOT NULL,
	"extraction" jsonb,
	"error" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"external_org_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"monthly_fee_cents" integer,
	"policy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_accounts_org_id_name_unique" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" "role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_unique" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"target" text NOT NULL,
	"min_risk" "alert_risk" DEFAULT 'at_risk' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"monthly_spend_cap_cents" integer,
	"require_mfa" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "replays" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"days" integer NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{"ticketsScanned":0,"ticketsTotal":null}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"active_org_id" uuid,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sla_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"policy_id" uuid,
	"metric" "metric" NOT NULL,
	"cycle_index" integer NOT NULL,
	"priority" "priority",
	"state" "cycle_state" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"breach_at" timestamp with time zone,
	"target_ms" bigint NOT NULL,
	"elapsed_ms" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_outcomes_ticket_id_metric_cycle_index_unique" UNIQUE("ticket_id","metric","cycle_index")
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "policy_status" DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"contract_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_policies_lineage_id_version_unique" UNIQUE("lineage_id","version")
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"author_role" text NOT NULL,
	"author_name" text,
	"author_external_id" text,
	"public" boolean NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_comments_ticket_id_source_id_unique" UNIQUE("ticket_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_events_ticket_id_idempotency_key_unique" UNIQUE("ticket_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"display_key" text NOT NULL,
	"url" text,
	"subject" text DEFAULT '' NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"requester_external_id" text,
	"requester_org_external_id" text,
	"customer_account_id" uuid,
	"policy_id" uuid,
	"status" "ticket_status" NOT NULL,
	"priority" "priority",
	"raw_status" text,
	"raw_priority" text,
	"assignee_external_id" text,
	"assignee_name" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at_source" timestamp with time zone NOT NULL,
	"updated_at_source" timestamp with time zone NOT NULL,
	"evaluation" jsonb,
	"risk" "risk" DEFAULT 'ok' NOT NULL,
	"next_due_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_connection_id_external_id_unique" UNIQUE("connection_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" bigint NOT NULL,
	"unit" text NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"ticket_id" uuid,
	"agent_run_id" uuid,
	"contract_id" uuid,
	"replay_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"mfa_secret" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_last_step" bigint,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_rules" ADD CONSTRAINT "autonomy_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_rules" ADD CONSTRAINT "autonomy_rules_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replays" ADD CONSTRAINT "replays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replays" ADD CONSTRAINT "replays_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replays" ADD CONSTRAINT "replays_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_org_id_organizations_id_fk" FOREIGN KEY ("active_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_outcomes" ADD CONSTRAINT "sla_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_outcomes" ADD CONSTRAINT "sla_outcomes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_outcomes" ADD CONSTRAINT "sla_outcomes_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_actions_org_id_status_index" ON "agent_actions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "agent_actions_ticket_id_index" ON "agent_actions" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "agent_runs_org_id_ticket_id_index" ON "agent_runs" USING btree ("org_id","ticket_id");--> statement-breakpoint
CREATE INDEX "agent_runs_org_id_contract_id_index" ON "agent_runs" USING btree ("org_id","contract_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_id_id_index" ON "audit_events" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "connections_org_id_index" ON "connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contracts_org_id_index" ON "contracts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "customer_accounts_org_id_index" ON "customer_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invitations_org_id_email_index" ON "invitations" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "memberships_user_id_index" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_channels_org_id_index" ON "notification_channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "replays_org_id_index" ON "replays" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_index" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sla_outcomes_org_id_stopped_at_index" ON "sla_outcomes" USING btree ("org_id","stopped_at");--> statement-breakpoint
CREATE INDEX "sla_outcomes_org_id_breach_at_index" ON "sla_outcomes" USING btree ("org_id","breach_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policies_one_active_per_lineage" ON "sla_policies" USING btree ("lineage_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policies_one_active_default_per_org" ON "sla_policies" USING btree ("org_id") WHERE status = 'active' and is_default;--> statement-breakpoint
CREATE INDEX "sla_policies_org_id_index" ON "sla_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket_id_at_index" ON "ticket_comments" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_id_at_index" ON "ticket_events" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "tickets_next_check_at_idx" ON "tickets" USING btree ("next_check_at") WHERE next_check_at is not null;--> statement-breakpoint
CREATE INDEX "tickets_org_id_risk_index" ON "tickets" USING btree ("org_id","risk");--> statement-breakpoint
CREATE INDEX "tickets_org_id_next_due_at_index" ON "tickets" USING btree ("org_id","next_due_at");--> statement-breakpoint
CREATE INDEX "tickets_org_id_customer_account_id_index" ON "tickets" USING btree ("org_id","customer_account_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_org_id_created_at_index" ON "usage_ledger" USING btree ("org_id","created_at");