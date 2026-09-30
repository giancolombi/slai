/**
 * The HTTP API contract between apps/api and apps/web.
 *
 * Conventions:
 * - Base path `/api/v1`. JSON everywhere except contract upload (multipart).
 * - Auth: better-auth, mounted at `/api/v1/auth/*` behind our middleware, with an
 *   httpOnly `slai_session` cookie. State-changing requests must send
 *   `X-Requested-With: slai` (CSRF defense alongside SameSite=Lax + Origin check),
 *   better-auth's endpoints included.
 * - MFA is mandatory: until a session has a second factor, every route outside
 *   `/auth/*` answers 403 `mfa_enrollment_required` (no factor yet) or
 *   `mfa_required` (a factor exists but this session has not used it).
 * - Timestamps are ISO-8601 strings. Money is integer cents. Durations are ms.
 * - Errors: `{ error: { code, message, details? } }` with a matching HTTP status.
 * - Lists: `{ items, nextCursor }`.
 *
 * Request bodies are zod schemas (the API validates with them; the web app
 * reuses them for forms). Responses are plain TypeScript types.
 */
import { z } from "zod";

// ---------- enums ----------

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const AUTONOMY = ["observe", "assist", "autopilot"] as const;
export type Autonomy = (typeof AUTONOMY)[number];
export const RISK = ["ok", "warning", "at_risk", "breached"] as const;
export type Risk = (typeof RISK)[number];
export type Priority = "urgent" | "high" | "normal" | "low";
export type TicketStatus = "new" | "open" | "pending" | "on_hold" | "solved" | "closed";
export type Metric = "first_response" | "next_response" | "periodic_update" | "resolution";
export type MetricState = "running" | "paused" | "achieved" | "breached" | "not_applicable";

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
export interface List<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------- auth ----------

export const signupBody = z.object({
  email: z.email(),
  password: z.string().min(12).max(200),
  name: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(120),
});
/** Step 1 of sign-in: which method does this email use? (By domain only: no user enumeration.) */
export const discoverBody = z.object({ email: z.email() });
export type SignInDiscovery =
  | { method: "password" }
  /** A verified SSO domain. `enforced`: password sign-in is disabled for it. */
  | { method: "sso"; providerId: string; enforced: boolean };
export const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});
export const verifyTotpBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export const verifyBackupCodeBody = z.object({ code: z.string().trim().min(6).max(32) });
export const ssoSignInBody = z
  .object({
    email: z.email().optional(),
    providerId: z.string().min(1).max(100).optional(),
    /** Where the web app lands after the IdP (a path on APP_URL). */
    redirect: z
      .string()
      .regex(/^\/(?!\/)/)
      .max(500)
      .optional(),
  })
  .refine((b) => b.email || b.providerId, "email or providerId is required");
export const switchOrgBody = z.object({ organizationId: z.uuid() });

export type AuthMethod = "password" | "passkey" | "sso";
export type SecondFactor = "totp" | "backup_code" | "passkey";
/**
 * The session's MFA state. Anything but `satisfied` blocks every route outside
 * `/auth/*` with 403 `mfa_enrollment_required` or `mfa_required`.
 */
export type MfaState = "satisfied" | "enrollment_required" | "verification_required";

export interface Me {
  user: { id: string; email: string; name: string; mfaEnabled: boolean };
  organization: { id: string; name: string; slug: string; plan: string };
  role: Role;
  organizations: { id: string; name: string; role: Role }[];
  security: {
    authMethod: AuthMethod;
    mfa: MfaState;
    /** A verified TOTP authenticator is enrolled. */
    totp: boolean;
    passkeys: number;
    /** The user has a password (SSO-only users do not). */
    hasPassword: boolean;
    /**
     * Sensitive actions (resetting a member's factors) need TOTP or a passkey proven
     * in this session within the last 5 minutes: until then (null: not fresh).
     */
    stepUpUntil: string | null;
  };
}

/**
 * The outcome of a sign-in step (`/auth/sign-in/email`, `/auth/two-factor/verify-*`,
 * `/auth/passkey/verify-authentication`). A bad credential or code is a 401
 * `invalid_credentials` / `invalid_code`; 403 `sso_required` means the email's
 * domain enforces SSO.
 */
export type SignInResult =
  | { status: "signed_in"; me: Me }
  /** The password was right; now a second factor (a session exists only after it). */
  | { status: "mfa_required"; methods: SecondFactor[] }
  /** Signed in, but only enrollment routes work until a second factor is added. */
  | { status: "mfa_enrollment_required"; me: Me };

/** `POST /auth/two-factor/enable`: the password is required when the user has one. */
export const totpEnableBody = z.object({ password: z.string().min(1).max(200).optional() });
/** Shown once. The secret is confirmed with `POST /auth/two-factor/verify-totp`. */
export interface TotpEnrollment {
  otpauthUrl: string;
  /** base32, for manual entry. */
  secret: string;
  backupCodes: string[];
}
export const regenerateBackupCodesBody = totpEnableBody;
export interface BackupCodes {
  backupCodes: string[];
}
export const disableTotpBody = totpEnableBody;
export interface Passkey {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}
export const deletePasskeyBody = z.object({ id: z.string().min(1).max(100) });
/** `POST /auth/step-up/passkey`: the WebAuthn assertion for `GET /auth/step-up/passkey-options`. */
export const stepUpPasskeyBody = z.object({ response: z.record(z.string(), z.unknown()) });
export interface StepUp {
  stepUpUntil: string;
}

// ---------- organization & members ----------

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  /** False once deactivated by the IdP (SCIM): they cannot use this organization. */
  active: boolean;
  /** Provisioned by the IdP (SCIM): its lifecycle, and with group mappings its role, come from there. */
  scimManaged: boolean;
}
/**
 * `POST /members/:userId/reset-mfa` (admin/owner, with a fresh step-up): removes the
 * member's TOTP, backup codes and passkeys, signs them out everywhere and emails them.
 */
export const resetMemberMfaBody = z.object({
  /** How the member's identity was checked (a ticket, a call). Recorded in the audit log. */
  reason: z.string().trim().min(10).max(500),
});
export interface MfaResetResult {
  userId: string;
  removed: { totp: boolean; passkeys: number };
  sessionsRevoked: number;
}
export const inviteBody = z.object({ email: z.email(), role: z.enum(ROLES) });
export const updateMemberBody = z.object({ role: z.enum(ROLES) });
export const updateOrgBody = z.object({
  name: z.string().min(1).max(120).optional(),
  monthlySpendCapCents: z.number().int().nonnegative().nullable().optional(),
});
export interface OrgSettings {
  id: string;
  name: string;
  plan: string;
  monthlySpendCapCents: number | null;
}

// ---------- SSO (org admins) ----------

export type SsoProtocol = "oidc" | "saml";
const ssoDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a domain like example.com");
const ssoCommon = {
  name: z.string().trim().min(1).max(120),
  domains: z.array(ssoDomain).min(1).max(10),
};
export const createSsoProviderBody = z.discriminatedUnion("protocol", [
  z.object({
    protocol: z.literal("oidc"),
    ...ssoCommon,
    issuer: z.url(),
    clientId: z.string().trim().min(1).max(500),
    /** Stored encrypted; never returned. */
    clientSecret: z.string().min(1).max(4000),
  }),
  z
    .object({
      protocol: z.literal("saml"),
      ...ssoCommon,
      metadataUrl: z.url().optional(),
      metadataXml: z.string().min(1).max(100_000).optional(),
    })
    .refine((b) => Boolean(b.metadataUrl) !== Boolean(b.metadataXml), "Give a metadata URL or the metadata XML"),
]);
export const updateSsoProviderBody = z.object({
  name: ssoCommon.name.optional(),
  /** Changing domains resets verification. */
  domains: ssoCommon.domains.optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  /** Omit to keep the stored secret. */
  clientSecret: z.string().min(1).max(4000).optional(),
  metadataUrl: z.url().optional(),
  metadataXml: z.string().min(1).max(100_000).optional(),
});
export interface SsoProvider {
  id: string;
  providerId: string;
  name: string;
  protocol: SsoProtocol;
  issuer: string;
  domains: string[];
  domainVerified: boolean;
  /** The DNS TXT record to publish on every domain (null once verified). */
  domainVerification: { recordName: string; recordValue: string } | null;
  /** OIDC: the client id only. The client secret is write-only. */
  clientId: string | null;
  /** SAML: where the metadata came from (null when XML was pasted). */
  metadataUrl: string | null;
  /** Register this at the IdP (OIDC redirect URI or SAML ACS URL). */
  callbackUrl: string;
  createdAt: string;
}
export const updateOrgSsoBody = z.object({
  /** Needs at least one verified provider. */
  enforceSso: z.boolean().optional(),
  /** Also require slai MFA for SSO sessions (default off: the IdP's MFA is trusted). */
  requireMfaForSso: z.boolean().optional(),
  /** Refuse SSO sign-ins unless the IdP asserts MFA (OIDC `amr`, SAML AuthnContextClassRef). */
  requireIdpMfa: z.boolean().optional(),
});
export interface OrgSsoSettings {
  enforceSso: boolean;
  requireMfaForSso: boolean;
  requireIdpMfa: boolean;
  providers: SsoProvider[];
}

// ---------- SCIM provisioning (org admins) ----------

/** A SCIM bearer token. The token itself is shown once, at creation. */
export interface ScimToken {
  id: string;
  name: string;
  /** The first characters, to tell tokens apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface ScimTokenCreated extends ScimToken {
  /** Shown once: paste it into the IdP's provisioning settings. */
  token: string;
}
export const createScimTokenBody = z.object({ name: z.string().trim().min(1).max(100) });
/** Roles an IdP group can grant (never owner: owners are managed in slai). */
export const SCIM_ROLES = ["admin", "member", "viewer"] as const;
export interface ScimGroupRole {
  id: string;
  /** The IdP group's display name, e.g. "slai-admins" (case-insensitive). */
  groupName: string;
  role: (typeof SCIM_ROLES)[number];
}
export const scimGroupRoleBody = z.object({
  groupName: z.string().trim().min(1).max(200),
  role: z.enum(SCIM_ROLES),
});
export interface ScimSettings {
  /** The SCIM 2.0 base URL to configure at the IdP. */
  baseUrl: string;
  tokens: ScimToken[];
  groupRoles: ScimGroupRole[];
}

// ---------- connections ----------

export interface ConnectorInfo {
  provider: string;
  displayName: string;
  authKind: "api_token" | "oauth2" | "basic";
  fields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string }[];
  supportsWebhooks: boolean;
  write: { internalNote: boolean; publicReply: boolean; assign: boolean; priority: boolean; tags: boolean };
  docsUrl: string;
}
export interface Connection {
  id: string;
  provider: string;
  name: string;
  status: "active" | "error" | "paused";
  lastSyncAt: string | null;
  lastError: string | null;
  /** Raw help-desk statuses/priorities the mapping did not recognise (found by sync). */
  mappingIssues: { field: "status" | "priority"; raw: string }[];
  webhookUrl: string | null;
  ticketCount: number;
  createdAt: string;
}
export const createConnectionBody = z.object({
  provider: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Secret values; stored encrypted and never returned. */
  credentials: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()).default({}),
});

// ---------- customers (our customer's customers) ----------

export interface CustomerAccount {
  id: string;
  name: string;
  domains: string[];
  externalOrgIds: string[];
  monthlyFeeCents: number | null;
  policyId: string | null;
  openTickets: number;
  atRiskTickets: number;
  breachesThisPeriod: number;
}
export const upsertCustomerBody = z.object({
  name: z.string().min(1).max(200),
  domains: z.array(z.string().min(1)).default([]),
  externalOrgIds: z.array(z.string()).default([]),
  monthlyFeeCents: z.number().int().nonnegative().nullable().default(null),
  policyId: z.uuid().nullable().default(null),
});

// ---------- contracts & policies ----------

export type ContractStatus = "uploaded" | "extracting" | "needs_review" | "approved" | "failed" | "archived";
export interface Contract {
  id: string;
  filename: string;
  customerAccountId: string | null;
  status: ContractStatus;
  uploadedAt: string;
  uploadedBy: string;
  error: string | null;
  /** Present once extraction finished. */
  extraction: {
    summary: string;
    policyIds: string[];
    ambiguities: { path: string; question: string; assumption: string; quote: string | null }[];
    citations: { path: string; quote: string; document: string; page: number | null }[];
  } | null;
}
/** `POST /contracts` is multipart: `file` (pdf/docx/txt/md, ≤ 20 MB) + optional `customerAccountId`. */

export type PolicyStatus = "draft" | "active" | "superseded" | "archived";
export interface Policy {
  id: string;
  name: string;
  version: number;
  status: PolicyStatus;
  contractId: string | null;
  isDefault: boolean;
  /** The engine's SlaPolicy definition (validated by @slai/sla-engine policySchema). */
  definition: unknown;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}
/**
 * `POST /policies`. `definition` is the engine's policy input; its `id` and `name` are
 * set by the server. `basedOn` (a policy id) creates the next draft version in that
 * policy's lineage instead of a new policy.
 */
export const createPolicyBody = z.object({
  name: z.string().min(1).max(200),
  definition: z.unknown(),
  isDefault: z.boolean().default(false),
  contractId: z.uuid().nullable().default(null),
  basedOn: z.uuid().nullable().default(null),
});
export const policyPreviewBody = z.object({
  connectionId: z.uuid().optional(),
  days: z.number().int().min(1).max(180).default(30),
});
export const updatePolicyBody = z.object({
  name: z.string().min(1).max(200).optional(),
  definition: z.unknown().optional(),
  isDefault: z.boolean().optional(),
});
/** `POST /policies/:id/approve` activates a draft (supersedes the prior version). Requires admin. */
export interface PolicyPreview {
  /** Replay of the last N days of tickets against this (draft) policy. */
  days: number;
  tickets: number;
  breaches: number;
  attainmentPercent: number | null;
  exposureCents: number;
}

// ---------- tickets ----------

export interface MetricView {
  metric: Metric;
  state: MetricState;
  targetMs: number | null;
  elapsedMs: number;
  remainingMs: number | null;
  dueAt: string | null;
  risk: Risk;
  breachCount: number;
}
export interface TicketSummary {
  id: string;
  connectionId: string;
  provider: string;
  displayKey: string;
  url: string | null;
  subject: string;
  status: TicketStatus;
  priority: Priority | null;
  customer: { id: string; name: string } | null;
  policy: { id: string; name: string } | null;
  risk: Risk;
  /** Most urgent live metric. */
  next: { metric: Metric; dueAt: string | null; remainingMs: number | null; state: MetricState } | null;
  assigneeName: string | null;
  updatedAt: string;
}
export interface TicketDetail extends TicketSummary {
  requester: { name: string | null; email: string | null };
  metrics: MetricView[];
  timeline: { at: string; type: string; label: string; author?: string; public?: boolean }[];
  agentRuns: AgentRun[];
  actions: AgentAction[];
}
/** `GET /tickets?risk=at_risk&status=open&customerId=&q=&cursor=` */

// ---------- agents ----------

export interface AgentRun {
  id: string;
  kind: "contract_extraction" | "triage" | "draft_reply";
  status: "queued" | "running" | "succeeded" | "failed";
  model: string | null;
  costCents: number;
  sandboxSeconds: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  output: unknown;
}
export type ActionKind = "internal_note" | "public_reply" | "set_priority" | "assign";
export type ActionStatus = "proposed" | "approved" | "sending" | "sent" | "rejected" | "failed" | "blocked";
export interface AgentAction {
  id: string;
  ticketId: string;
  ticketKey: string;
  ticketSubject: string;
  kind: ActionKind;
  status: ActionStatus;
  body: string | null;
  payload: unknown;
  confidence: number | null;
  /** Why autopilot did not send it (guardrail), if blocked. */
  blockedReason: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}
export const approveActionBody = z.object({ body: z.string().min(1).max(20000).optional() });
export const rejectActionBody = z.object({ reason: z.string().max(2000).optional() });

export interface AutonomyRule {
  id: string;
  /** Null matches all. Most specific match wins: customer > priority > default. */
  customerAccountId: string | null;
  priority: Priority | null;
  level: Autonomy;
  /** Risk level at which agents are dispatched. */
  triggerAt: Exclude<Risk, "ok">;
  minConfidence: number;
}
export const autonomyRuleBody = z.object({
  customerAccountId: z.uuid().nullable(),
  priority: z.enum(["urgent", "high", "normal", "low"]).nullable(),
  level: z.enum(AUTONOMY),
  triggerAt: z.enum(["warning", "at_risk", "breached"]),
  minConfidence: z.number().min(0).max(1).default(0.8),
});

// ---------- dashboard, replay, usage, audit ----------

export interface DashboardSummary {
  period: { start: string; end: string };
  openTickets: number;
  byRisk: Record<Risk, number>;
  breachesThisPeriod: number;
  attainmentPercent: number | null;
  exposureCents: number;
  /** Tickets that reached at_risk and were then met in time after slai acted. */
  savedBreaches: number;
  savedCents: number;
  dueSoon: TicketSummary[];
  attainmentTrend: { date: string; percent: number | null; breaches: number }[];
  pendingApprovals: number;
}

export const createReplayBody = z.object({
  connectionId: z.uuid(),
  days: z.number().int().min(1).max(180).default(90),
});
export interface Replay {
  id: string;
  connectionId: string;
  days: number;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: { ticketsScanned: number; ticketsTotal: number | null };
  result: {
    tickets: number;
    breaches: number;
    attainmentPercent: number | null;
    exposureCents: number;
    byCustomer: { customerId: string | null; name: string; breaches: number; exposureCents: number }[];
    byMetric: { metric: Metric; breaches: number; measured: number }[];
    /** Median minutes of warning slai would have given before each breach. */
    medianLeadMinutes: number | null;
  } | null;
  createdAt: string;
}

export interface UsageSummary {
  period: { start: string; end: string };
  creditsUsed: number;
  costCents: number;
  spendCapCents: number | null;
  byKind: { kind: string; count: number; costCents: number }[];
  trackedTickets: number;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: { type: "user" | "system" | "agent"; id: string | null; name: string | null };
  action: string;
  target: { type: string; id: string | null };
  metadata: unknown;
  ip: string | null;
}

export interface NotificationChannel {
  id: string;
  kind: "email" | "slack_webhook";
  target: string;
  minRisk: Exclude<Risk, "ok">;
  enabled: boolean;
}
export const notificationChannelBody = z.object({
  kind: z.enum(["email", "slack_webhook"]),
  target: z.string().min(1).max(500),
  minRisk: z.enum(["warning", "at_risk", "breached"]).default("at_risk"),
  enabled: z.boolean().default(true),
});

/**
 * Route table (all under /api/v1):
 *
 * Auth (ours):
 *   POST   /auth/signup            signupBody → 201 SignInResult (mfa_enrollment_required)
 *   POST   /auth/discover          discoverBody → SignInDiscovery
 *   POST   /auth/logout            → 204
 *   GET    /auth/me                → Me (works while MFA is pending)
 *   POST   /auth/switch-org        { organizationId } → Me
 *   GET    /auth/step-up/passkey-options → WebAuthn request options (MFA done)
 *   POST   /auth/step-up/passkey   stepUpPasskeyBody → StepUp (TOTP step-up: /auth/two-factor/verify-totp)
 * Auth (better-auth, allowlisted; responses normalized to our DTOs and errors):
 *   POST   /auth/sign-in/email     loginBody → SignInResult | 403 sso_required
 *   POST   /auth/sign-in/sso       ssoSignInBody → { url } (then the browser goes to the IdP)
 *   GET    /auth/sso/callback/:providerId        (OIDC redirect URI; sets the session, redirects to the app)
 *   POST   /auth/sso/saml2/sp/acs/:providerId    (SAML ACS; CSRF-exempt, signature-verified)
 *   GET    /auth/sso/saml2/sp/metadata?providerId=
 *   POST   /auth/two-factor/verify-totp          verifyTotpBody → SignInResult (sign-in or enrollment)
 *   POST   /auth/two-factor/verify-backup-code   verifyBackupCodeBody → SignInResult (single use)
 *   POST   /auth/two-factor/enable               totpEnableBody → TotpEnrollment
 *   POST   /auth/two-factor/generate-backup-codes  regenerateBackupCodesBody → BackupCodes (MFA done)
 *   POST   /auth/two-factor/disable              disableTotpBody → 204 (needs another factor)
 *   GET    /auth/passkey/generate-register-options   → WebAuthn creation options
 *   POST   /auth/passkey/verify-registration     { response, name? } → Passkey
 *   GET    /auth/passkey/generate-authenticate-options → WebAuthn request options
 *   POST   /auth/passkey/verify-authentication   { response } → SignInResult
 *   GET    /auth/passkey/list-user-passkeys      → Passkey[] (MFA done)
 *   POST   /auth/passkey/delete-passkey          deletePasskeyBody → 204 (needs another factor)
 *   Every other better-auth endpoint is 404.
 *
 *   GET    /org                    → OrgSettings          PATCH /org  updateOrgBody (admin)
 *   GET    /org/sso                → OrgSsoSettings (admin)   PATCH /org/sso updateOrgSsoBody (admin)
 *   POST   /org/sso/providers      createSsoProviderBody → SsoProvider (admin)
 *   PATCH  /org/sso/providers/:id  updateSsoProviderBody → SsoProvider (admin)
 *   DELETE /org/sso/providers/:id  (admin)
 *   POST   /org/sso/providers/:id/verify-domain → SsoProvider | 422 domain_not_verified (admin)
 *   GET    /members                → List<Member>         POST /members/invite inviteBody (admin)
 *   PATCH  /members/:userId        { role } (owner)       DELETE /members/:userId (admin)
 *   POST   /members/:userId/reset-mfa  resetMemberMfaBody → MfaResetResult (admin; 403 step_up_required,
 *                                   cannot_reset_owner, cross_org_member; 409 last_owner, self_reset)
 *   GET    /org/scim               → ScimSettings (admin)
 *   POST   /org/scim/tokens        createScimTokenBody → 201 ScimTokenCreated (admin)
 *   DELETE /org/scim/tokens/:id    → 204, revokes (admin)
 *   POST   /org/scim/group-roles   scimGroupRoleBody → 201 ScimGroupRole (admin)   DELETE /org/scim/group-roles/:id
 *
 * SCIM 2.0 (not under /api/v1; `Authorization: Bearer <org SCIM token>`, application/scim+json):
 *   GET    /scim/v2/ServiceProviderConfig
 *   GET    /scim/v2/Users?filter=userName eq "x"   POST /scim/v2/Users
 *   GET|PUT|PATCH|DELETE /scim/v2/Users/:id        (active=false deactivates; DELETE removes the member)
 *   GET    /scim/v2/Groups?filter=displayName eq "x"  POST /scim/v2/Groups
 *   GET|PUT|PATCH|DELETE /scim/v2/Groups/:id
 *
 *   GET    /connectors             → ConnectorInfo[]
 *   GET    /connections            → List<Connection>     POST /connections createConnectionBody (admin)
 *   GET    /connections/:id        → Connection           DELETE /connections/:id (admin)
 *   POST   /connections/:id/test   → { ok, accountName }
 *   POST   /connections/:id/sync   → 202
 *   POST   /webhooks/:connectionId (public; signature-verified by the connector)
 *
 *   GET    /customers              → List<CustomerAccount>   POST /customers upsertCustomerBody
 *   PATCH  /customers/:id          upsertCustomerBody.partial()   DELETE /customers/:id
 *
 *   GET    /contracts              → List<Contract>       POST /contracts (multipart) → Contract
 *   GET    /contracts/:id          → Contract             POST /contracts/:id/extract → 202
 *   GET    /contracts/:id/file     → the original file (download)
 *
 *   GET    /policies               → List<Policy>         POST /policies { name, definition } → Policy
 *   GET    /policies/:id           → Policy               PATCH /policies/:id updatePolicyBody (draft only)
 *   POST   /policies/:id/approve   → Policy (admin)       POST /policies/:id/archive
 *   POST   /policies/:id/preview   { connectionId?, days } → PolicyPreview
 *
 *   GET    /tickets                → List<TicketSummary>  GET /tickets/:id → TicketDetail
 *   POST   /tickets/:id/agents/:kind  (kind = triage | draft_reply) → AgentRun
 *
 *   GET    /actions?status=proposed → List<AgentAction>
 *   POST   /actions/:id/approve    approveActionBody → AgentAction
 *   POST   /actions/:id/reject     rejectActionBody → AgentAction
 *
 *   GET    /autonomy-rules         → AutonomyRule[]       POST autonomyRuleBody; PUT/DELETE /autonomy-rules/:id (admin)
 *   GET    /notification-channels  → NotificationChannel[]  POST/PATCH/DELETE (admin)
 *
 *   GET    /dashboard              → DashboardSummary
 *   POST   /replays                createReplayBody → Replay     GET /replays, /replays/:id
 *   GET    /usage                  → UsageSummary
 *   GET    /audit-events?cursor=   → List<AuditEvent> (admin)
 *   GET    /events                 Server-Sent Events: `ticket.updated`, `action.created`, `replay.progress`
 *   GET    /healthz, /readyz       (unauthenticated)
 */
export const API_BASE = "/api/v1";
