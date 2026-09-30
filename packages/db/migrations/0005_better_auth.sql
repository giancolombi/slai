-- better-auth (T-15 to T-17): identity tables for better-auth, mandatory MFA, and SSO.
--
-- better-auth's models map onto our tables: user -> users, session -> sessions,
-- account -> accounts, verification -> verifications, twoFactor -> two_factors,
-- passkey -> passkeys, ssoProvider -> sso_providers (apps/api/src/auth/better-auth.ts).
--
-- Data migration:
--   * Every argon2id users.password_hash becomes a `credential` account row, so
--     existing passwords keep working (better-auth verifies them with our argon2id).
--   * Old TOTP secrets were sealed with crypto.ts and cannot be carried into
--     better-auth's two_factors format in SQL, and org require_mfa is gone (MFA is
--     now mandatory). Every user starts with mfa_enabled = false and is forced into
--     enrollment on their next sign-in.
--   * All sessions are revoked (the cookie format changed).
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_id_account_id_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"domain_verified" boolean DEFAULT false NOT NULL,
	"domain_verification_token" text,
	"oidc_config" text,
	"saml_config" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "two_factors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "enforce_sso" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sso_require_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sso_org_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
INSERT INTO "accounts" ("user_id", "account_id", "provider_id", "password", "created_at", "updated_at")
  SELECT "id", "id"::text, 'credential', "password_hash", "created_at", now() FROM "users";--> statement-breakpoint
UPDATE "users" SET "mfa_enabled" = false;--> statement-breakpoint
DELETE FROM "sessions";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_index" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_id_index" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sso_providers_org_id_index" ON "sso_providers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_index" ON "verifications" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sso_org_id_organizations_id_fk" FOREIGN KEY ("sso_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "require_mfa";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "last_seen_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "mfa_secret";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "mfa_last_step";--> statement-breakpoint

-- ---------- roles ----------
--   slai_auth  better-auth's own connection (DATABASE_AUTH_URL): the only role that
--              can read password hashes, TOTP secrets, sessions, passkeys and SSO
--              configs. BYPASSRLS because sign-in resolves users, memberships and
--              SSO domains before any org is known; its grants are limited to the
--              identity tables plus what signup and JIT provisioning write.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slai_auth') THEN
    CREATE ROLE slai_auth LOGIN PASSWORD 'slai_auth' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO slai_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications, two_factors, passkeys, sso_providers TO slai_auth;
--> statement-breakpoint
GRANT SELECT, INSERT ON organizations, memberships TO slai_auth;
--> statement-breakpoint
GRANT SELECT (id, org_id, email, role, expires_at, accepted_at) ON invitations TO slai_auth;
--> statement-breakpoint
GRANT INSERT ON audit_events TO slai_auth;
--> statement-breakpoint

-- ---------- slai_worker loses auth ----------
-- Auth moved to slai_auth, so the system role no longer touches sessions or writes users.
REVOKE ALL ON sessions FROM slai_worker;
--> statement-breakpoint
REVOKE INSERT, UPDATE ON users FROM slai_worker;
--> statement-breakpoint

-- ---------- slai_app ----------
-- Org admins list their SSO providers through withOrg. oidc_config holds only
-- ciphertext for the client secret; writes go through better-auth (slai_auth).
-- No grant at all on accounts, verifications, two_factors, passkeys or sessions.
GRANT SELECT ON sso_providers TO slai_app;
--> statement-breakpoint
ALTER TABLE sso_providers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sso_providers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON sso_providers
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
