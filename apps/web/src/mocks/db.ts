/**
 * The mock API's in-memory database: one dataset per organization, persisted to
 * sessionStorage so a demo survives reloads (and "Reset demo data" starts over).
 * Clocks are derived at request time from stored due instants, so risk moves
 * ok → warning → at_risk → breached while you watch.
 */
import type {
  AgentAction,
  AuditEvent,
  AutonomyRule,
  Connection,
  Contract,
  DashboardSummary,
  Me,
  Member,
  MetricView,
  NotificationChannel,
  OrgSettings,
  OrgSsoSettings,
  Passkey,
  Policy,
  Replay,
  Risk,
  TicketDetail,
  TicketSummary,
  UsageSummary,
} from "@slai/shared";
import { RISK_ORDER, riskForFraction } from "@slai/ui";
import {
  ACME_ORG_ID,
  buildActions,
  buildAudit,
  buildAutonomyRules,
  buildChannels,
  buildConnections,
  buildContracts,
  buildCustomers,
  buildMe,
  buildMembers,
  buildOrgSettings,
  buildOrgSso,
  buildPolicies,
  buildReplays,
  buildRuns,
  buildTickets,
  DAY,
  HOUR,
  type MockCustomer,
  type MockMetric,
  type MockTicket,
  PLAN_LIMITS,
  SANDBOX_ORG_ID,
} from "./fixtures";

export interface OrgData {
  settings: OrgSettings;
  sso: OrgSsoSettings;
  members: Member[];
  connections: Connection[];
  customers: MockCustomer[];
  contracts: Contract[];
  policies: Policy[];
  tickets: MockTicket[];
  actions: AgentAction[];
  autonomy: AutonomyRule[];
  channels: NotificationChannel[];
  replays: Replay[];
  audit: AuditEvent[];
  /** Extra usage recorded during the demo (cents). */
  usageExtraCents: number;
  /** When the org was created (drives the dashboard period). */
  createdAt: number;
}

export interface MockDb {
  version: number;
  /** "in" | "out" | "mfa" (password ok, second factor pending). */
  session: "in" | "out" | "mfa";
  me: Me;
  /** The demo user's single-use backup codes and passkeys (mock only). */
  backupCodes: string[];
  passkeys: Passkey[];
  orgs: Record<string, OrgData>;
}

const STORAGE_KEY = "slai-mock-db";
const VERSION = 6;

/** Mock-mode backup codes (any 6-digit TOTP code except 000000 is accepted). */
export const MOCK_BACKUP_CODES = Array.from({ length: 10 }, (_, i) => `mock${i}-codes`);

function seedAcme(now: number): OrgData {
  const customers = buildCustomers();
  const tickets = buildTickets(now, customers);
  const actions = buildActions(now, tickets, (t) => deriveTicket(t, now).risk);
  const withDraft = new Set(
    actions.filter((a) => a.status === "proposed" || a.status === "blocked").map((a) => a.ticketId),
  );
  for (const t of tickets) t.agentRuns = buildRuns(now, t, withDraft.has(t.id));
  return {
    settings: buildOrgSettings(),
    sso: buildOrgSso(),
    members: buildMembers(now),
    connections: buildConnections(now),
    customers,
    contracts: buildContracts(now),
    policies: buildPolicies(now),
    tickets,
    actions,
    autonomy: buildAutonomyRules(),
    channels: buildChannels(),
    replays: buildReplays(now),
    audit: buildAudit(now),
    usageExtraCents: 0,
    createdAt: now - 142 * DAY,
  };
}

export function emptyOrg(id: string, name: string, owner: Member, now: number): OrgData {
  return {
    settings: { id, name, plan: "replay", monthlySpendCapCents: null },
    sso: { enforceSso: false, requireMfaForSso: false, requireIdpMfa: false, providers: [] },
    members: [owner],
    connections: [],
    customers: [],
    contracts: [],
    policies: [],
    tickets: [],
    actions: [],
    autonomy: [
      {
        id: `ar_default_${id.slice(0, 6)}`,
        customerAccountId: null,
        priority: null,
        level: "observe",
        triggerAt: "at_risk",
        minConfidence: 0.8,
      },
    ],
    channels: [],
    replays: [],
    audit: [],
    usageExtraCents: 0,
    createdAt: now,
  };
}

function seed(): MockDb {
  const now = Date.now();
  const me = buildMe();
  const sandboxOwner: Member = {
    userId: me.user.id,
    email: me.user.email,
    name: me.user.name,
    role: "admin",
    mfaEnabled: true,
    lastLoginAt: null,
    active: true,
    scimManaged: false,
  };
  return {
    version: VERSION,
    session: "in",
    me,
    backupCodes: MOCK_BACKUP_CODES.slice(),
    passkeys: [
      {
        id: "pk_macbook",
        name: "MacBook Touch ID",
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: new Date(now - 20 * DAY).toISOString(),
      },
    ],
    orgs: {
      [ACME_ORG_ID]: seedAcme(now),
      [SANDBOX_ORG_ID]: emptyOrg(SANDBOX_ORG_ID, "Acme Cloud (Sandbox)", sandboxOwner, now),
    },
  };
}

let db: MockDb | null = null;

export function getDb(): MockDb {
  if (db) return db;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb;
      if (parsed.version === VERSION) db = parsed;
    }
  } catch {
    /* ignore */
  }
  db ??= seed();
  return db;
}

export function saveDb() {
  try {
    if (db) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* storage full or unavailable: keep in memory */
  }
}

export function resetDb() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  db = seed();
  saveDb();
}

export function org(): OrgData {
  const d = getDb();
  return d.orgs[d.me.organization.id]!;
}

// ---------------------------------------------------------------- derivations (stand-in for the engine)

function deriveMetric(m: MockMetric, now: number, warnAt: number[] = [0.5, 0.8]): MetricView {
  const target = m.targetMs;
  if (m.state === "not_applicable" || target === null) {
    return {
      metric: m.metric,
      state: "not_applicable",
      targetMs: target,
      elapsedMs: 0,
      remainingMs: null,
      dueAt: null,
      risk: "ok",
      breachCount: 0,
    };
  }
  if (m.state === "achieved") {
    const elapsed = m.frozenElapsedMs ?? 0;
    return {
      metric: m.metric,
      state: "achieved",
      targetMs: target,
      elapsedMs: elapsed,
      remainingMs: target - elapsed,
      dueAt: null,
      risk: "ok",
      breachCount: m.breachCount,
    };
  }
  if (m.state === "paused") {
    const remaining = m.pausedRemainingMs ?? 0;
    const elapsed = target - remaining;
    return {
      metric: m.metric,
      state: "paused",
      targetMs: target,
      elapsedMs: elapsed,
      remainingMs: remaining,
      dueAt: null,
      risk: riskForFraction(elapsed / target, warnAt),
      breachCount: remaining < 0 ? 1 : 0,
    };
  }
  const due = m.dueAt ?? now;
  const remaining = due - now;
  const elapsed = target - remaining;
  const breached = remaining < 0;
  return {
    metric: m.metric,
    state: breached ? "breached" : "running",
    targetMs: target,
    elapsedMs: elapsed,
    remainingMs: remaining,
    dueAt: new Date(due).toISOString(),
    risk: riskForFraction(elapsed / target, warnAt),
    breachCount: breached ? Math.max(1, m.breachCount) : m.breachCount,
  };
}

export function deriveTicket(t: MockTicket, now: number) {
  const metrics = t.metrics.map((m) => deriveMetric(m, now));
  const live = metrics.filter((m) => m.state === "running" || m.state === "paused" || m.state === "breached");
  const closed = t.status === "solved" || t.status === "closed";
  const risk: Risk = closed
    ? metrics.some((m) => m.state === "breached")
      ? "breached"
      : "ok"
    : live.reduce<Risk>((worst, m) => (RISK_ORDER[m.risk] > RISK_ORDER[worst] ? m.risk : worst), "ok");
  const next =
    closed || live.length === 0
      ? null
      : [...live].sort((a, b) => {
          const pa = a.state === "paused" ? 1 : 0;
          const pb = b.state === "paused" ? 1 : 0;
          return pa - pb || (a.remainingMs ?? 0) - (b.remainingMs ?? 0);
        })[0]!;
  return { metrics, risk, next };
}

export function toSummary(t: MockTicket, now: number): TicketSummary {
  const o = org();
  const { risk, next } = deriveTicket(t, now);
  const customer = o.customers.find((c) => c.id === t.customerId);
  const policy = o.policies.find((p) => p.id === t.policyId);
  return {
    id: t.id,
    connectionId: t.connectionId,
    provider: t.provider,
    displayKey: t.displayKey,
    url: t.url,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    policy: policy ? { id: policy.id, name: policy.name } : null,
    risk,
    next: next ? { metric: next.metric, dueAt: next.dueAt, remainingMs: next.remainingMs, state: next.state } : null,
    assigneeName: t.assigneeName,
    updatedAt: new Date(t.updatedAt).toISOString(),
  };
}

export function toDetail(t: MockTicket, now: number): TicketDetail {
  const o = org();
  const { metrics } = deriveTicket(t, now);
  return {
    ...toSummary(t, now),
    requester: t.requester,
    metrics,
    timeline: t.timeline,
    agentRuns: t.agentRuns,
    actions: o.actions.filter((a) => a.ticketId === t.id),
  };
}

export function dashboard(now: number): DashboardSummary {
  const o = org();
  const open = o.tickets.filter((t) => t.status !== "solved" && t.status !== "closed");
  const summaries = open.map((t) => toSummary(t, now));
  const byRisk: Record<Risk, number> = { ok: 0, warning: 0, at_risk: 0, breached: 0 };
  for (const s of summaries) byRisk[s.risk]++;
  const dueSoon = summaries
    .filter((s) => s.next && s.next.state === "running" && (s.next.remainingMs ?? 0) >= 0 && s.risk !== "ok")
    .sort((a, b) => (a.next!.remainingMs ?? 0) - (b.next!.remainingMs ?? 0))
    .slice(0, 8);
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const hasData = o.tickets.length > 0;
  const trend: DashboardSummary["attainmentTrend"] = [];
  if (hasData) {
    let seed = 11;
    for (let d = 29; d >= 0; d--) {
      seed = (seed * 9301 + 49297) % 233280;
      const noise = seed / 233280;
      const dip = d === 17 || d === 16 ? 3.4 : d === 6 ? 1.8 : 0;
      const pct = Math.min(99.8, 96.2 + noise * 3 - dip + (29 - d) * 0.04);
      trend.push({
        date: new Date(now - d * DAY).toISOString().slice(0, 10),
        percent: Number(pct.toFixed(1)),
        breaches: Math.max(0, Math.round((100 - pct) * 1.4 + (noise > 0.8 ? 1 : 0))),
      });
    }
  }
  const breachesThisPeriod = hasData ? 14 + byRisk.breached : 0;
  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    openTickets: open.length,
    byRisk,
    breachesThisPeriod,
    attainmentPercent: hasData ? 97.6 : null,
    exposureCents: hasData ? 1_842_500 + byRisk.breached * 42_000 : 0,
    savedBreaches: hasData ? 23 : 0,
    savedCents: hasData ? 2_310_000 : 0,
    dueSoon,
    attainmentTrend: trend,
    pendingApprovals: o.actions.filter((a) => a.status === "proposed").length,
  };
}

export function usage(now: number): UsageSummary {
  const o = org();
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  if (o.tickets.length === 0) {
    return {
      period: { start: start.toISOString(), end: end.toISOString() },
      creditsUsed: 0,
      costCents: o.usageExtraCents,
      spendCapCents: o.settings.monthlySpendCapCents,
      byKind: [],
      trackedTickets: 0,
    };
  }
  const byKind = [
    { kind: "triage", count: 3_214, costCents: 9_642 },
    { kind: "draft_reply", count: 1_146, costCents: 34_380 },
    { kind: "autopilot_reply", count: 212, costCents: 10_600 },
    { kind: "contract_extraction", count: 6, costCents: 2_700 },
    { kind: "policy_preview", count: 14, costCents: 420 },
    { kind: "sandbox_seconds", count: 41_870, costCents: 4_187 + o.usageExtraCents },
  ];
  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    creditsUsed: 18_420 + Math.round(o.usageExtraCents / 3),
    costCents: byKind.reduce((s, k) => s + k.costCents, 0),
    spendCapCents: o.settings.monthlySpendCapCents,
    byKind,
    trackedTickets: 5_214,
  };
}

export function planLimit(plan: string) {
  return PLAN_LIMITS[plan] ?? 7_500;
}

export function audit(
  actorName: string | null,
  action: string,
  target: { type: string; id: string | null },
  metadata: unknown = {},
) {
  const o = org();
  o.audit.unshift({
    id: `ae_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    actor: { type: actorName ? "user" : "system", id: actorName ? getDb().me.user.id : null, name: actorName },
    action,
    target,
    metadata,
    ip: actorName ? "198.51.100.24" : null,
  });
}

export { HOUR };
