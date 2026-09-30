/**
 * The slai schema. Every table except the identity tables (`users`, `sessions`,
 * `accounts`, `verifications`, `two_factors`, `passkeys`) is org-scoped: it has
 * `org_id` and a forced RLS policy `org_id = current_setting('app.org_id')`
 * (see migrations/0002_security.sql and 0004_better_auth.sql). `organizations`
 * is scoped by its own `id`.
 *
 * The identity tables are better-auth's models mapped onto our names (see
 * apps/api/src/auth/better-auth.ts). Only the `slai_auth` role can read their
 * secret columns.
 *
 * Columns holding secrets are ciphertext (never plaintext):
 * - `crypto.ts` (AES-256-GCM, key id, AAD): connections.credentials,
 *   connections.webhook_secret, notification_channels.target for Slack
 *   webhooks, and the OIDC client secret inside sso_providers.oidc_config.
 * - better-auth's versioned envelope (XChaCha20-Poly1305 under SESSION_SECRET):
 *   two_factors.secret, two_factors.backup_codes, and accounts' OAuth tokens.
 * sessions.token_hash is the sha256 of the cookie token, never the token.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const bigNumber = (name: string) => bigint(name, { mode: "number" });

// ---------- enums ----------

export const roleEnum = pgEnum("role", ["owner", "admin", "member", "viewer"]);
export const riskEnum = pgEnum("risk", ["ok", "warning", "at_risk", "breached"]);
export const priorityEnum = pgEnum("priority", ["urgent", "high", "normal", "low"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["new", "open", "pending", "on_hold", "solved", "closed"]);
export const metricEnum = pgEnum("metric", ["first_response", "next_response", "periodic_update", "resolution"]);
export const cycleStateEnum = pgEnum("cycle_state", ["running", "paused", "achieved", "breached"]);
export const connectionStatusEnum = pgEnum("connection_status", ["active", "error", "paused"]);
export const contractStatusEnum = pgEnum("contract_status", [
  "uploaded",
  "extracting",
  "needs_review",
  "approved",
  "failed",
  "archived",
]);
export const policyStatusEnum = pgEnum("policy_status", ["draft", "active", "superseded", "archived"]);
export const agentKindEnum = pgEnum("agent_kind", ["contract_extraction", "triage", "draft_reply"]);
export const runStatusEnum = pgEnum("run_status", ["queued", "running", "succeeded", "failed"]);
export const actionKindEnum = pgEnum("action_kind", ["internal_note", "public_reply", "set_priority", "assign"]);
export const actionStatusEnum = pgEnum("action_status", [
  "proposed",
  "approved",
  /** Claimed by a worker; the help-desk write may or may not have happened (T-49). */
  "sending",
  "sent",
  "rejected",
  "failed",
  "blocked",
]);
export const autonomyEnum = pgEnum("autonomy", ["observe", "assist", "autopilot"]);
export const alertRiskEnum = pgEnum("alert_risk", ["warning", "at_risk", "breached"]);
export const channelKindEnum = pgEnum("channel_kind", ["email", "slack_webhook"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "system", "agent"]);

// ---------- identity ----------

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("trial"),
  monthlySpendCapCents: integer("monthly_spend_cap_cents"),
  /** Password and passkey sign-in are refused for emails on this org's verified SSO domains. */
  enforceSso: boolean("enforce_sso").notNull().default(false),
  /** SSO sessions must also pass slai MFA (by default the IdP's MFA is trusted). */
  ssoRequireMfa: boolean("sso_require_mfa").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** better-auth's `twoFactorEnabled`: a verified TOTP factor exists. The password lives in `accounts`. */
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  lastLoginAt: ts("last_login_at"),
  disabledAt: ts("disabled_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.orgId, t.userId), index().on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    /** sha256 (hex) of the cookie token (better-auth's `token`, hashed by the sealing adapter). */
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrgId: uuid("active_org_id").references(() => organizations.id, { onDelete: "set null" }),
    /** How the session was established: password (+ second factor), passkey, or sso. */
    authMethod: text("auth_method").notNull().default("password"),
    /** A second factor was verified for this session (TOTP, backup code, passkey). */
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    /** For SSO sessions: the organization whose IdP authenticated the user. */
    ssoOrgId: uuid("sso_org_id").references(() => organizations.id, { onDelete: "set null" }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Sliding idle expiry (12h, refreshed on use). The 7-day absolute limit is checked against created_at. */
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index().on(t.userId), index().on(t.expiresAt)],
);

/** better-auth accounts: the argon2id password (`provider_id = 'credential'`) and SSO identities. */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** argon2id PHC string (credential accounts only). */
    password: text("password"),
    /** OAuth/OIDC tokens, encrypted by better-auth (`encryptOAuthTokens`). */
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId), unique().on(t.providerId, t.accountId)],
);

/** better-auth verification values: 2FA challenges, SSO state, passkey challenges. Short-lived. */
export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.identifier)],
);

/** better-auth twoFactor: the encrypted TOTP secret and backup codes. */
export const twoFactors = pgTable("two_factors", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: ts("locked_until"),
  createdAt: createdAt(),
});

/** better-auth passkeys (WebAuthn credentials). */
export const passkeys = pgTable(
  "passkeys",
  {
    id: id(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: orgId(),
    email: citext("email").notNull(),
    role: roleEnum("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.orgId, t.email)],
);

/** Append-only: a trigger rejects UPDATE, DELETE and TRUNCATE. `org_id` is null for pre-auth events. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    at: ts("at").notNull().defaultNow(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
  },
  (t) => [index().on(t.orgId, t.id)],
);

/**
 * better-auth ssoProvider: one per IdP, owned by an organization. `oidc_config`
 * is better-auth's JSON with `clientSecret` sealed by `crypto.ts` (AAD
 * `sso_provider:<provider_id>`); the sealing adapter decrypts it for better-auth only.
 */
export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: id(),
    orgId: orgId(),
    /** Stable id used in callback URLs (`/sso/callback/:providerId`). */
    providerId: text("provider_id").notNull().unique(),
    name: text("name").notNull().default(""),
    issuer: text("issuer").notNull(),
    /** Comma-separated email domains. */
    domain: text("domain").notNull(),
    domainVerified: boolean("domain_verified").notNull().default(false),
    /** Published as `_slai-verification.<domain> TXT slai-verification=<token>`. Not a secret. */
    domainVerificationToken: text("domain_verification_token"),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId)],
);

// ---------- help desk ----------

export const connections = pgTable(
  "connections",
  {
    id: id(),
    orgId: orgId(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    status: connectionStatusEnum("status").notNull().default("active"),
    /** Encrypted JSON of the connector's credentials. */
    credentials: text("credentials").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    mapping: jsonb("mapping").$type<{ status: Record<string, string>; priority: Record<string, string | null> }>(),
    /** Encrypted. */
    webhookSecret: text("webhook_secret"),
    syncCursor: text("sync_cursor"),
    lastSyncAt: ts("last_sync_at"),
    lastError: text("last_error"),
    /** Raw statuses/priorities the mapping did not recognise (set by the worker's sync; shown in the UI). */
    mappingIssues: jsonb("mapping_issues")
      .$type<{ field: "status" | "priority"; raw: string }[]>()
      .notNull()
      .default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId)],
);

export const customerAccounts = pgTable(
  "customer_accounts",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
    externalOrgIds: text("external_org_ids").array().notNull().default(sql`'{}'::text[]`),
    monthlyFeeCents: integer("monthly_fee_cents"),
    policyId: uuid("policy_id").references((): AnyPgColumn => slaPolicies.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId), unique().on(t.orgId, t.name)],
);

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    orgId: orgId(),
    customerAccountId: uuid("customer_account_id").references((): AnyPgColumn => customerAccounts.id, {
      onDelete: "set null",
    }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: contractStatusEnum("status").notNull().default("uploaded"),
    extraction: jsonb("extraction"),
    error: text("error"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId)],
);

export const slaPolicies = pgTable(
  "sla_policies",
  {
    id: id(),
    orgId: orgId(),
    /** Groups the versions of one policy. Equal to the first version's id. */
    lineageId: uuid("lineage_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    status: policyStatusEnum("status").notNull().default("draft"),
    /** The engine's SlaPolicy, always stored as validated by parsePolicy. */
    definition: jsonb("definition").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    contractId: uuid("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.lineageId, t.version),
    uniqueIndex("sla_policies_one_active_per_lineage").on(t.lineageId).where(sql`status = 'active'`),
    uniqueIndex("sla_policies_one_active_default_per_org").on(t.orgId).where(sql`status = 'active' and is_default`),
    index().on(t.orgId),
  ],
);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    displayKey: text("display_key").notNull(),
    url: text("url"),
    subject: text("subject").notNull().default(""),
    requesterName: text("requester_name"),
    requesterEmail: text("requester_email"),
    requesterExternalId: text("requester_external_id"),
    requesterOrgExternalId: text("requester_org_external_id"),
    customerAccountId: uuid("customer_account_id").references(() => customerAccounts.id, { onDelete: "set null" }),
    policyId: uuid("policy_id").references(() => slaPolicies.id, { onDelete: "set null" }),
    status: ticketStatusEnum("status").notNull(),
    priority: priorityEnum("priority"),
    rawStatus: text("raw_status"),
    rawPriority: text("raw_priority"),
    assigneeExternalId: text("assignee_external_id"),
    assigneeName: text("assignee_name"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAtSource: ts("created_at_source").notNull(),
    updatedAtSource: ts("updated_at_source").notNull(),
    /** StoredEvaluation (see evaluation.ts): the engine's TicketEvaluation as JSON. */
    evaluation: jsonb("evaluation"),
    risk: riskEnum("risk").notNull().default("ok"),
    nextDueAt: ts("next_due_at"),
    /** When the timer sweep must re-evaluate this ticket (engine's nextTransitionAt). */
    nextCheckAt: ts("next_check_at"),
    lastEvaluatedAt: ts("last_evaluated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.connectionId, t.externalId),
    index("tickets_next_check_at_idx").on(t.nextCheckAt).where(sql`next_check_at is not null`),
    index().on(t.orgId, t.risk),
    index().on(t.orgId, t.nextDueAt),
    index().on(t.orgId, t.customerAccountId),
  ],
);

export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: id(),
    orgId: orgId(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    type: text("type").notNull(),
    at: ts("at").notNull(),
    /** The CanonicalEvent minus `type`, `at` and `idempotencyKey`. */
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.ticketId, t.idempotencyKey), index().on(t.ticketId, t.at)],
);

export const ticketComments = pgTable(
  "ticket_comments",
  {
    id: id(),
    orgId: orgId(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    at: ts("at").notNull(),
    authorRole: text("author_role").notNull(),
    authorName: text("author_name"),
    authorExternalId: text("author_external_id"),
    public: boolean("public").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.ticketId, t.sourceId), index().on(t.ticketId, t.at)],
);

export const slaOutcomes = pgTable(
  "sla_outcomes",
  {
    id: id(),
    orgId: orgId(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => slaPolicies.id, { onDelete: "set null" }),
    metric: metricEnum("metric").notNull(),
    cycleIndex: integer("cycle_index").notNull(),
    priority: priorityEnum("priority"),
    state: cycleStateEnum("state").notNull(),
    startedAt: ts("started_at").notNull(),
    stoppedAt: ts("stopped_at"),
    breachAt: ts("breach_at"),
    targetMs: bigNumber("target_ms").notNull(),
    elapsedMs: bigNumber("elapsed_ms").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.ticketId, t.metric, t.cycleIndex),
    index().on(t.orgId, t.stoppedAt),
    index().on(t.orgId, t.breachAt),
  ],
);

// ---------- agents ----------

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    orgId: orgId(),
    kind: agentKindEnum("kind").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "cascade" }),
    model: text("model"),
    provider: text("provider"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costMicros: bigNumber("cost_micros").notNull().default(0),
    sandboxId: text("sandbox_id"),
    sandboxSeconds: real("sandbox_seconds"),
    output: jsonb("output"),
    error: text("error"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index().on(t.orgId, t.ticketId), index().on(t.orgId, t.contractId)],
);

export const agentActions = pgTable(
  "agent_actions",
  {
    id: id(),
    orgId: orgId(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    kind: actionKindEnum("kind").notNull(),
    status: actionStatusEnum("status").notNull().default("proposed"),
    body: text("body"),
    payload: jsonb("payload").notNull().default({}),
    confidence: real("confidence"),
    blockedReason: text("blocked_reason"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    externalRef: text("external_ref"),
    error: text("error"),
    /** The current send claim: set on approved → sending, so a retry can tell an in-flight write from a lost one. */
    sendAttemptId: uuid("send_attempt_id"),
    sendingAt: ts("sending_at"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId, t.status), index().on(t.ticketId)],
);

export const autonomyRules = pgTable(
  "autonomy_rules",
  {
    id: id(),
    orgId: orgId(),
    customerAccountId: uuid("customer_account_id").references(() => customerAccounts.id, { onDelete: "cascade" }),
    priority: priorityEnum("priority"),
    level: autonomyEnum("level").notNull(),
    triggerAt: alertRiskEnum("trigger_at").notNull(),
    minConfidence: real("min_confidence").notNull().default(0.8),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.orgId, t.customerAccountId, t.priority).nullsNotDistinct()],
);

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: id(),
    orgId: orgId(),
    kind: channelKindEnum("kind").notNull(),
    /** Email address in plaintext; Slack webhook URLs are encrypted. */
    target: text("target").notNull(),
    minRisk: alertRiskEnum("min_risk").notNull().default("at_risk"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.orgId)],
);

export const replays = pgTable(
  "replays",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    days: integer("days").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    progress: jsonb("progress")
      .$type<{ ticketsScanned: number; ticketsTotal: number | null }>()
      .notNull()
      .default({ ticketsScanned: 0, ticketsTotal: null }),
    result: jsonb("result"),
    error: text("error"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index().on(t.orgId)],
);

/** Append-only (trigger-enforced), like audit_events. */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: id(),
    orgId: orgId(),
    /** e.g. "model_call", "sandbox_seconds", "tracked_ticket". */
    kind: text("kind").notNull(),
    quantity: bigNumber("quantity").notNull(),
    /** e.g. "tokens", "seconds", "tickets". */
    unit: text("unit").notNull(),
    costMicros: bigNumber("cost_micros").notNull().default(0),
    credits: integer("credits").notNull().default(0),
    ticketId: uuid("ticket_id"),
    agentRunId: uuid("agent_run_id"),
    contractId: uuid("contract_id"),
    replayId: uuid("replay_id"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

/** Every org-scoped table (RLS applies). Used by tests to assert coverage. */
export const ORG_SCOPED_TABLES = [
  "memberships",
  "sso_providers",
  "invitations",
  "audit_events",
  "connections",
  "customer_accounts",
  "contracts",
  "sla_policies",
  "tickets",
  "ticket_events",
  "ticket_comments",
  "sla_outcomes",
  "agent_runs",
  "agent_actions",
  "autonomy_rules",
  "notification_channels",
  "replays",
  "usage_ledger",
] as const;
