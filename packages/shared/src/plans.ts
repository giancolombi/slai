/**
 * Plans as code (T-65, specs/product.md §4). Prices, limits, the agent
 * ceiling per tier, the trial, credit packs, and the pure billing rules that
 * the API, the worker and the web app all share. No I/O.
 *
 * Money is integer cents. 1 credit = 1 cent.
 */

/** Credits per billable action (specs/product.md §4; 1 credit = 1 cent). */
export const ACTION_CREDITS = { triage: 3, draft_reply: 20, autopilot_reply: 60 } as const;

export const PLAN_IDS = ["replay", "starter", "growth", "scale", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
/** The plans a customer can buy through self-serve checkout. */
export const CHECKOUT_PLANS = ["starter", "growth", "scale"] as const;
export type CheckoutPlanId = (typeof CHECKOUT_PLANS)[number];

/**
 * The most an agent may do on a plan, from least to most:
 * observe (monitoring and alerts only), triage (observe plus triage runs),
 * assist (drafts for approval), autopilot (guarded auto-send).
 */
export const AGENT_CEILINGS = ["observe", "triage", "assist", "autopilot"] as const;
export type AgentCeiling = (typeof AGENT_CEILINGS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price; null for free (Replay) or contract (Enterprise). */
  priceCents: number | null;
  /** SLA-tracked tickets included per month; null means set by contract. */
  trackedTickets: number | null;
  includedCredits: number;
  ceiling: AgentCeiling;
  /** Price per tracked ticket over the limit, billed in arrears; null when overage is not billed. */
  ticketOverageCents: number | null;
  /** Whether AI credits beyond included + purchased are billed (up to the spend cap). */
  creditOverage: boolean;
  selfServe: boolean;
  summary: string;
}

export const PLANS: Record<PlanId, Plan> = {
  replay: {
    id: "replay",
    name: "Replay",
    priceCents: 0,
    trackedTickets: 0,
    includedCredits: 0,
    ceiling: "observe",
    ticketOverageCents: null,
    creditOverage: false,
    selfServe: false,
    summary: "One-time 90-day Breach Replay on a read-only connection. No card.",
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceCents: 29_900,
    trackedTickets: 1_500,
    includedCredits: 5_000,
    ceiling: "triage",
    ticketOverageCents: 20,
    creditOverage: true,
    selfServe: true,
    summary: "SLA monitoring, alerts and AI triage.",
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceCents: 99_900,
    trackedTickets: 7_500,
    includedCredits: 20_000,
    ceiling: "assist",
    ticketOverageCents: 20,
    creditOverage: true,
    selfServe: true,
    summary: "Everything in Starter, plus AI drafts for approval.",
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceCents: 249_900,
    trackedTickets: 25_000,
    includedCredits: 60_000,
    ceiling: "autopilot",
    ticketOverageCents: 20,
    creditOverage: true,
    selfServe: true,
    summary: "Everything in Growth, plus guarded autopilot replies.",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceCents: null,
    trackedTickets: null,
    includedCredits: 250_000,
    ceiling: "autopilot",
    ticketOverageCents: null,
    creditOverage: true,
    selfServe: false,
    summary: "Committed credits, SSO, optional breach-prevention guarantee.",
  },
};

/** New organizations start here. */
export const TRIAL = {
  plan: "growth" as PlanId,
  days: 14,
  /** Growth's drafts for approval, but never autopilot. */
  ceiling: "assist" as AgentCeiling,
  /** No card on file, so a smaller allowance and no overage. */
  includedCredits: 5_000,
  warnDaysBefore: 3,
} as const;

/** After a failed payment, the plan keeps working this long; then agents degrade to observe. */
export const PAST_DUE_GRACE_DAYS = 7;
/** The default spend cap allows this much of the included credits on top of included + purchased. */
export const OVERAGE_ALLOWANCE_PERCENT = 50;

export interface CreditPack {
  id: string;
  credits: number;
  priceCents: number;
}
export const CREDIT_PACKS: CreditPack[] = [
  { id: "credits_10k", credits: 10_000, priceCents: 10_000 },
  { id: "credits_50k", credits: 50_000, priceCents: 45_000 },
];

export const BILLING_STATUSES = ["trialing", "active", "past_due", "canceled"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/**
 * What the org may do right now, derived from its stored status and time:
 * - trialing / trial_expired: the in-app trial (no subscription)
 * - active; past_due (inside the grace period); degraded (past due beyond it)
 * - canceled
 */
export type BillingState = "trialing" | "trial_expired" | "active" | "past_due" | "degraded" | "canceled";

const DAY_MS = 86_400_000;

export function isPlanId(s: string): s is PlanId {
  return (PLAN_IDS as readonly string[]).includes(s);
}

export function planOf(id: string): Plan {
  return isPlanId(id) ? PLANS[id] : PLANS.growth;
}

export interface BillingFacts {
  plan: string;
  status: BillingStatus;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
}

export interface Entitlements {
  plan: Plan;
  state: BillingState;
  ceiling: AgentCeiling;
  includedCredits: number;
  /** Tracked-ticket limit for the period; null means no limit (contract). */
  trackedTicketLimit: number | null;
  /** Whether overage (tickets and credits) is billed; false means it is flagged only. */
  overageBilled: boolean;
  trialDaysLeft: number | null;
  graceEndsAt: Date | null;
  reason: string;
}

/**
 * The entitlements for an org at `now`. Monitoring and alerts are never part
 * of this: they run in every state. Only the agent ceiling and credits change.
 */
export function entitlements(f: BillingFacts, now: Date): Entitlements {
  const plan = planOf(f.plan);
  const base = {
    plan,
    trackedTicketLimit: plan.trackedTickets,
    trialDaysLeft: null,
    graceEndsAt: null,
  };
  if (f.status === "trialing") {
    const left = f.trialEndsAt ? f.trialEndsAt.getTime() - now.getTime() : 0;
    if (left > 0) {
      return {
        ...base,
        state: "trialing",
        ceiling: minCeiling(plan.ceiling, TRIAL.ceiling),
        includedCredits: TRIAL.includedCredits,
        overageBilled: false,
        trialDaysLeft: Math.ceil(left / DAY_MS),
        reason: "trial: autopilot off",
      };
    }
    return {
      ...base,
      state: "trial_expired",
      ceiling: "observe",
      includedCredits: 0,
      overageBilled: false,
      trialDaysLeft: 0,
      reason: "trial ended: observe only",
    };
  }
  if (f.status === "canceled") {
    return {
      ...base,
      state: "canceled",
      ceiling: "observe",
      includedCredits: 0,
      overageBilled: false,
      reason: "subscription canceled: observe only",
    };
  }
  const overageBilled = plan.ticketOverageCents !== null || plan.creditOverage;
  if (f.status === "past_due") {
    const since = f.pastDueSince ?? now;
    const graceEndsAt = new Date(since.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
    if (now < graceEndsAt) {
      return {
        ...base,
        state: "past_due",
        ceiling: plan.ceiling,
        includedCredits: plan.includedCredits,
        overageBilled,
        graceEndsAt,
        reason: "payment past due: grace period",
      };
    }
    return {
      ...base,
      state: "degraded",
      ceiling: "observe",
      includedCredits: plan.includedCredits,
      overageBilled: false,
      graceEndsAt,
      reason: "payment past due: observe only",
    };
  }
  return {
    ...base,
    state: "active",
    ceiling: plan.ceiling,
    includedCredits: plan.includedCredits,
    overageBilled,
    reason: `plan ${plan.id}`,
  };
}

export function ceilingRank(c: AgentCeiling): number {
  return AGENT_CEILINGS.indexOf(c);
}

export function minCeiling(a: AgentCeiling, b: AgentCeiling): AgentCeiling {
  return ceilingRank(a) <= ceilingRank(b) ? a : b;
}

export interface CreditBalanceInput {
  /** Credits consumed this period (usage_ledger). */
  used: number;
  /** Included credits for this period (from entitlements). */
  included: number;
  /** Purchased credits still available at the start of the period, plus packs bought during it. */
  purchasedAvailable: number;
  /** The owner's explicit monthly cap (cents = credits); null uses the default. */
  capOverrideCents: number | null;
  /** Whether credits past included + purchased may be used (and billed). */
  overageAllowed: boolean;
  allowancePercent?: number;
}

export interface CreditBalance {
  fromIncluded: number;
  fromPurchased: number;
  /** Credits used beyond included + purchased. */
  overage: number;
  /** The spend cap in credits: agents degrade to observe at or above it. */
  cap: number;
  /** Credits left before the cap (never negative). */
  remaining: number;
  overCap: boolean;
}

/**
 * Consumption draws on included credits first, then purchased, then overage.
 * The default cap is included + purchased + 50% of included; an owner's
 * override replaces it. Without overage (trials, canceled), the cap never
 * exceeds included + purchased.
 */
export function creditBalance(i: CreditBalanceInput): CreditBalance {
  const used = Math.max(0, i.used);
  const fromIncluded = Math.min(used, i.included);
  const fromPurchased = Math.min(used - fromIncluded, Math.max(0, i.purchasedAvailable));
  const overage = used - fromIncluded - fromPurchased;
  const prepaid = i.included + Math.max(0, i.purchasedAvailable);
  const allowance = i.overageAllowed
    ? Math.floor((i.included * (i.allowancePercent ?? OVERAGE_ALLOWANCE_PERCENT)) / 100)
    : 0;
  let cap = i.capOverrideCents ?? prepaid + allowance;
  if (!i.overageAllowed) cap = Math.min(cap, prepaid);
  return {
    fromIncluded,
    fromPurchased,
    overage,
    cap,
    remaining: Math.max(0, cap - used),
    overCap: used >= cap,
  };
}

/** Tracked tickets over the plan's limit (0 when there is no limit). */
export function trackedOverage(tracked: number, limit: number | null): number {
  return limit === null ? 0 : Math.max(0, tracked - limit);
}

/**
 * Maps a Stripe subscription status to ours. Stripe trials are not used (the
 * trial is in-app), so a Stripe "trialing" subscription is paid-for: active.
 */
export function mapStripeStatus(s: string): BillingStatus {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    default:
      return "canceled";
  }
}

/** A calendar-month billing period in UTC (the same period as the spend cap). */
export function billingPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * A ticket is SLA-tracked in a period if any of its SLA cycles was live
 * during it: started before the period ends, and not stopped before it began.
 */
export function cycleLiveIn(
  cycle: { startedAt: Date; stoppedAt: Date | null },
  period: { start: Date; end: Date },
): boolean {
  return cycle.startedAt < period.end && (cycle.stoppedAt === null || cycle.stoppedAt >= period.start);
}
