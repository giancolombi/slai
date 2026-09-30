/**
 * Pure decision rules for the worker. No I/O: the worker loads rows, calls
 * these, and persists the outcome. Keeping them pure keeps them testable and
 * auditable ("why did slai send this reply?").
 */
import type { Priority, RiskLevel } from "@slai/sla-engine";

export type Autonomy = "observe" | "assist" | "autopilot";

const RISK_RANK: Record<RiskLevel, number> = { ok: 0, warning: 1, at_risk: 2, breached: 3 };

// ---------- which customer account / policy applies ----------

export interface CustomerMatchCandidate {
  id: string;
  domains: string[];
  externalOrgIds: string[];
  policyId: string | null;
}

/**
 * Matches a ticket's requester to one of our customer's customer accounts:
 * first by help-desk organization id (exact), then by email domain (the most
 * specific domain wins, so "eu.acme.com" beats "acme.com").
 */
export function matchCustomerAccount(
  requester: { email: string | null; orgSourceId: string | null },
  accounts: CustomerMatchCandidate[],
): CustomerMatchCandidate | null {
  if (requester.orgSourceId) {
    const byOrg = accounts.find((a) => a.externalOrgIds.includes(requester.orgSourceId as string));
    if (byOrg) return byOrg;
  }
  const domain = requester.email?.split("@")[1]?.toLowerCase().trim();
  if (!domain) return null;
  let best: { account: CustomerMatchCandidate; len: number } | null = null;
  for (const a of accounts) {
    for (const d of a.domains) {
      const dd = d.toLowerCase().replace(/^@/, "").trim();
      if (domain === dd || domain.endsWith(`.${dd}`)) {
        if (!best || dd.length > best.len) best = { account: a, len: dd.length };
      }
    }
  }
  return best?.account ?? null;
}

/** The customer's assigned policy, else the org's default active policy. */
export function resolvePolicyId(account: CustomerMatchCandidate | null, defaultPolicyId: string | null): string | null {
  return account?.policyId ?? defaultPolicyId;
}

// ---------- autonomy ----------

export interface AutonomyRuleLike {
  id: string;
  customerAccountId: string | null;
  priority: Priority | null;
  level: Autonomy;
  triggerAt: Exclude<RiskLevel, "ok">;
  minConfidence: number;
}

export const DEFAULT_AUTONOMY: Omit<AutonomyRuleLike, "id"> & { id: null } = {
  id: null,
  customerAccountId: null,
  priority: null,
  level: "observe",
  triggerAt: "at_risk",
  minConfidence: 0.8,
};

/**
 * Most specific rule wins: customer+priority > customer > priority > org default.
 * With no rules at all, slai only observes.
 */
export function resolveAutonomy(
  rules: AutonomyRuleLike[],
  ticket: { customerAccountId: string | null; priority: Priority | null },
): AutonomyRuleLike | typeof DEFAULT_AUTONOMY {
  const score = (r: AutonomyRuleLike): number => {
    if (r.customerAccountId !== null && r.customerAccountId !== ticket.customerAccountId) return -1;
    if (r.priority !== null && r.priority !== ticket.priority) return -1;
    return (r.customerAccountId !== null ? 2 : 0) + (r.priority !== null ? 1 : 0);
  };
  let best: AutonomyRuleLike | null = null;
  let bestScore = -1;
  for (const r of rules) {
    const s = score(r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best ?? DEFAULT_AUTONOMY;
}

// ---------- reacting to risk transitions ----------

export function crossed(prev: RiskLevel | null, next: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_RANK[next] >= RISK_RANK[threshold] && (prev === null || RISK_RANK[prev] < RISK_RANK[threshold]);
}

// ---------- first evaluation (TR-21f) ----------

/** How long after a breach a ticket slai sees for the first time is still worth acting on. */
export const FIRST_SEEN_GRACE_MS = 60 * 60_000;

export interface MetricLike {
  state: string;
  risk: RiskLevel;
  cycles: { stoppedAt: Date | null; breachAt: Date | null }[];
}

/**
 * The risk that may count as a crossing on a ticket's first evaluation (first
 * connect, a full backfill). Only live metrics count: a stopped cycle's breach
 * is history no agent can change. A live metric that breached more than
 * `graceMs` ago counts for nothing either: the moment to act passed before
 * slai saw the ticket. What is left is the risk an alert or a draft can still
 * do something about.
 */
export function actionableRisk(metrics: MetricLike[], now: Date, graceMs = FIRST_SEEN_GRACE_MS): RiskLevel {
  let worst: RiskLevel = "ok";
  for (const m of metrics) {
    const current = m.cycles.at(-1);
    if (!current || current.stoppedAt !== null) continue;
    if (m.state === "breached") {
      if (current.breachAt === null || now.getTime() - current.breachAt.getTime() > graceMs) continue;
    }
    if (RISK_RANK[m.risk] > RISK_RANK[worst]) worst = m.risk;
  }
  return worst;
}

/**
 * A crossing of `threshold` that slai should react to. Later evaluations use
 * the plain risk crossing; the first one (no previous risk) must also cross on
 * the actionable risk, so connecting a help desk full of long-overdue tickets
 * does not fire a burst of alerts and drafts.
 */
export function actionableCrossing(
  prev: RiskLevel | null,
  next: RiskLevel,
  actionable: RiskLevel,
  threshold: RiskLevel,
): boolean {
  return crossed(prev, next, threshold) && (prev !== null || crossed(null, actionable, threshold));
}

export type SpendState = "ok" | "over_cap";

export interface DispatchDecision {
  runTriage: boolean;
  runDraft: boolean;
  /** Whether a passing draft may be sent without a human (subject to guardrails). */
  mayAutoSend: boolean;
  /** The effective level after spend-cap degradation. */
  effectiveLevel: Autonomy;
  reason: string;
}

/**
 * What to do when a ticket's risk changes. Agents are dispatched once per
 * crossing of the rule's trigger (not on every re-evaluation), and never for
 * closed tickets. Over the spend cap, autonomy degrades to observe; the
 * SLA clock and alerts are never throttled.
 */
export function decideDispatch(input: {
  prevRisk: RiskLevel | null;
  nextRisk: RiskLevel;
  /** On a first evaluation (`prevRisk` null), the still-actionable risk (`actionableRisk`); ignored otherwise. */
  actionableRisk: RiskLevel;
  ticketOpen: boolean;
  rule: Pick<AutonomyRuleLike, "level" | "triggerAt">;
  spend: SpendState;
  /** True when an agent already produced a pending/sent action for this ticket since its last customer message. */
  alreadyHandled: boolean;
}): DispatchDecision {
  const none = (reason: string, effectiveLevel: Autonomy = input.rule.level): DispatchDecision => ({
    runTriage: false,
    runDraft: false,
    mayAutoSend: false,
    effectiveLevel,
    reason,
  });
  if (!input.ticketOpen) return none("ticket is not open");
  const effectiveLevel: Autonomy = input.spend === "over_cap" ? "observe" : input.rule.level;
  if (effectiveLevel === "observe") {
    return none(input.spend === "over_cap" ? "spend cap reached: observe only" : "autonomy is observe", "observe");
  }
  if (!crossed(input.prevRisk, input.nextRisk, input.rule.triggerAt)) return none("trigger not crossed");
  if (!actionableCrossing(input.prevRisk, input.nextRisk, input.actionableRisk, input.rule.triggerAt)) {
    return none("first seen already breached beyond the grace window");
  }
  if (input.alreadyHandled) return none("already handled since the last customer message");
  return {
    runTriage: true,
    runDraft: true,
    mayAutoSend: effectiveLevel === "autopilot",
    effectiveLevel,
    reason: `risk ${input.prevRisk ?? "new"} → ${input.nextRisk} crossed ${input.rule.triggerAt}`,
  };
}

/**
 * Channels to notify for this transition (each fires once per crossing of its
 * minimum). On a first evaluation, `actionable` applies as in `decideDispatch`.
 */
export function channelsToNotify<C extends { minRisk: Exclude<RiskLevel, "ok">; enabled: boolean }>(
  channels: C[],
  prev: RiskLevel | null,
  next: RiskLevel,
  actionable: RiskLevel,
): C[] {
  return channels.filter((c) => c.enabled && actionableCrossing(prev, next, actionable, c.minRisk));
}

// ---------- spend ----------

export function spendState(spentMicros: number, capCents: number | null): SpendState {
  if (capCents === null) return "ok";
  return spentMicros >= capCents * 10_000 ? "over_cap" : "ok";
}
