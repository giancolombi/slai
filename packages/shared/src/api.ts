/**
 * The HTTP API contract between apps/api and apps/web.
 *
 * Conventions:
 * - Base path `/api/v1`. JSON everywhere except contract upload (multipart).
 * - Auth: an httpOnly `slai_session` cookie; state-changing requests must send
 *   `X-Requested-With: slai` (CSRF defense alongside SameSite=Lax + Origin check).
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
export const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export const mfaVerifyBody = z.object({ totp: z.string().regex(/^\d{6}$/) });
export const switchOrgBody = z.object({ organizationId: z.uuid() });

export interface Me {
  user: { id: string; email: string; name: string; mfaEnabled: boolean };
  organization: { id: string; name: string; slug: string; plan: string };
  role: Role;
  organizations: { id: string; name: string; role: Role }[];
}
/** `POST /auth/login` returns 200 Me, or 401 `{error:{code:"mfa_required"}}` when TOTP is needed. */
export interface MfaSetup {
  otpauthUrl: string;
  secret: string;
}

// ---------- organization & members ----------

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}
export const inviteBody = z.object({ email: z.email(), role: z.enum(ROLES) });
/** `POST /members/invite` → 201 Invitation. The token is never returned; it goes only to the invitee. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}
export const updateMemberBody = z.object({ role: z.enum(ROLES) });
export const updateOrgBody = z.object({
  name: z.string().min(1).max(120).optional(),
  monthlySpendCapCents: z.number().int().nonnegative().nullable().optional(),
  requireMfa: z.boolean().optional(),
});
export interface OrgSettings {
  id: string;
  name: string;
  plan: string;
  monthlySpendCapCents: number | null;
  requireMfa: boolean;
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
  /** User id of the uploader (null if that user was deleted). */
  uploadedBy: string | null;
  /** The uploader's display name, so clients needn't resolve `uploadedBy`. */
  uploadedByName: string | null;
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
  /** User id of the approving admin; null while a draft. */
  approvedBy: string | null;
  /** The approver's display name. */
  approvedByName: string | null;
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
  /**
   * User id of the person who approved or rejected it. Null with `decidedAt` set means
   * slai decided on its own (an autopilot send, or an assist-mode internal note).
   */
  decidedBy: string | null;
  /** The decider's display name (null when `decidedBy` is null). */
  decidedByName: string | null;
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
 *   POST   /auth/signup            signupBody → Me
 *   POST   /auth/login             loginBody → Me | 401 mfa_required
 *   POST   /auth/logout
 *   GET    /auth/me                → Me
 *   POST   /auth/mfa/setup         → MfaSetup
 *   POST   /auth/mfa/verify        mfaVerifyBody → Me
 *   POST   /auth/switch-org        { organizationId } → Me
 *
 *   GET    /org                    → OrgSettings          PATCH /org  updateOrgBody (admin)
 *   GET    /members                → List<Member>         POST /members/invite inviteBody → Invitation (admin)
 *   PATCH  /members/:userId        { role } (owner)       DELETE /members/:userId (admin)
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
export { API_BASE } from "./base.js";
