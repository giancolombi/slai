-- T-18 SCIM provisioning and T-19 factor recovery / IdP MFA claims.
--   * memberships: disabled_at (SCIM deactivation), scim_managed, scim_external_id
--   * sessions: step_up_at (fresh TOTP/passkey proof), idp_amr / idp_acr (IdP MFA claims)
--   * organizations: sso_require_idp_mfa
--   * scim_tokens (hashed bearer tokens), scim_groups, scim_group_members, scim_group_roles
CREATE TABLE "scim_group_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_members_group_id_membership_id_unique" UNIQUE("group_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "scim_group_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_name" "citext" NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_roles_org_id_group_name_unique" UNIQUE("org_id","group_name")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" "citext" NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_org_id_display_name_unique" UNIQUE("org_id","display_name")
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scim_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scim_external_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sso_require_idp_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "step_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_amr" text[];--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idp_acr" text;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_roles" ADD CONSTRAINT "scim_group_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_group_members_membership_id_index" ON "scim_group_members" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "scim_tokens_org_id_index" ON "scim_tokens" USING btree ("org_id");--> statement-breakpoint

-- ---------- grants (T-18 SCIM, T-19 factor recovery) ----------
-- SCIM groups and role mappings are org data: slai_app through withOrg (RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups, scim_group_members, scim_group_roles TO slai_app;
--> statement-breakpoint
-- slai_app lists an org's SCIM tokens but never sees their hashes.
GRANT SELECT (id, org_id, name, token_prefix, created_by, last_used_at, revoked_at, created_at) ON scim_tokens TO slai_app;
--> statement-breakpoint
-- slai_auth resolves a bearer token (by hash) to its org before any org is known,
-- creates tokens and revokes them. Tokens are never deleted (the audit trail refers to them).
GRANT SELECT, INSERT, UPDATE ON scim_tokens TO slai_auth;
--> statement-breakpoint

-- ---------- row-level security ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scim_tokens', 'scim_groups', 'scim_group_members', 'scim_group_roles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;