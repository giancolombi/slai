-- Security: database roles, least-privilege grants, forced row-level security,
-- and append-only tables. See docs/SOC2.md.
--
-- Roles are cluster-wide and created only if missing, so a password set in a
-- real environment (ALTER ROLE ... PASSWORD) is never overwritten. The
-- passwords below are for local development only.
--
--   slai_app     The API and worker for all org data. NOBYPASSRLS: every query
--                is confined to current_setting('app.org_id') by RLS (withOrg).
--   slai_worker  "systemDb": auth lookups (users, sessions, memberships) and
--                cross-org scheduling sweeps. BYPASSRLS, but granted only the
--                tables/columns those jobs need; it cannot read ticket content,
--                contracts, credentials or policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slai_app') THEN
    CREATE ROLE slai_app LOGIN PASSWORD 'slai_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slai_worker') THEN
    CREATE ROLE slai_worker LOGIN PASSWORD 'slai_worker' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
ALTER ROLE slai_app NOSUPERUSER NOBYPASSRLS;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO slai_app, slai_worker;
--> statement-breakpoint

-- ---------- slai_app ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  memberships, invitations, connections, customer_accounts, contracts, sla_policies, tickets,
  ticket_events, ticket_comments, sla_outcomes, agent_runs, agent_actions, autonomy_rules,
  notification_channels, replays
TO slai_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON organizations TO slai_app;
--> statement-breakpoint
-- Append-only tables: no UPDATE/DELETE grant (and a trigger below, for every role).
GRANT SELECT, INSERT ON audit_events, usage_ledger TO slai_app;
--> statement-breakpoint
-- No password hashes or MFA secrets, and no sessions, for the app role.
GRANT SELECT (id, email, name, mfa_enabled, last_login_at, disabled_at, created_at) ON users TO slai_app;
--> statement-breakpoint

-- ---------- slai_worker (systemDb) ----------
GRANT SELECT, INSERT, UPDATE ON users TO slai_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO slai_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON memberships, organizations TO slai_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON invitations TO slai_worker;
--> statement-breakpoint
GRANT INSERT ON audit_events TO slai_worker;
--> statement-breakpoint
GRANT SELECT (id, org_id, next_check_at, status) ON tickets TO slai_worker;
--> statement-breakpoint
GRANT SELECT (id, org_id, provider, status, last_sync_at) ON connections TO slai_worker;
--> statement-breakpoint

-- ---------- row-level security ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'invitations', 'audit_events', 'connections', 'customer_accounts', 'contracts',
    'sla_policies', 'tickets', 'ticket_events', 'ticket_comments', 'sla_outcomes', 'agent_runs',
    'agent_actions', 'autonomy_rules', 'notification_channels', 'replays', 'usage_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON organizations
  USING (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

-- ---------- append-only ----------
CREATE OR REPLACE FUNCTION slai_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION slai_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION slai_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER usage_ledger_append_only BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION slai_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER usage_ledger_no_truncate BEFORE TRUNCATE ON usage_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION slai_reject_mutation();
