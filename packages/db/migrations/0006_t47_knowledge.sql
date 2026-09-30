CREATE TYPE "public"."knowledge_source_kind" AS ENUM('helpdesk_articles', 'saved_replies', 'manual');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('idle', 'syncing', 'error');--> statement-breakpoint
CREATE TABLE "knowledge_articles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"url" text,
	"body_text" text NOT NULL,
	"locale" text,
	"updated_at_source" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(body_text, '')), 'B')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_articles_source_id_external_id_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid,
	"kind" "knowledge_source_kind" NOT NULL,
	"name" text NOT NULL,
	"status" "knowledge_source_status" DEFAULT 'idle' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_articles_search_idx" ON "knowledge_articles" USING gin ("search");--> statement-breakpoint
CREATE INDEX "knowledge_articles_org_id_source_id_index" ON "knowledge_articles" USING btree ("org_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_org_id_index" ON "knowledge_sources" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_one_per_connection_kind" ON "knowledge_sources" USING btree ("connection_id","kind") WHERE connection_id is not null;--> statement-breakpoint
-- Security (as in 0002_security): the app role reads and writes knowledge
-- under forced RLS; the worker's system role sees only the scheduling columns
-- it needs to enqueue the daily sync, never article content.
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_sources, knowledge_articles TO slai_app;
--> statement-breakpoint
GRANT SELECT (id, org_id, connection_id, kind, status, last_sync_at) ON knowledge_sources TO slai_worker;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_sources', 'knowledge_articles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
