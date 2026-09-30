/**
 * Billing reads shared by the API and the worker (T-65). All run inside
 * `withOrg` (RLS confines them to one org). The rules themselves are pure and
 * live in @slai/shared plans.ts; this module only loads their inputs.
 */
import {
  billingPeriod,
  type CreditBalance,
  creditBalance,
  type Entitlements,
  entitlements,
  trackedOverage,
} from "@slai/shared";
import { and, gte, lt, sql } from "drizzle-orm";
import type { Tx } from "./client.js";
import { billingPeriods, creditGrants, organizations, slaOutcomes, usageLedger } from "./schema.js";

export type Period = { start: Date; end: Date };

export interface OrgBilling {
  id: string;
  plan: string;
  status: (typeof organizations.$inferSelect)["billingStatus"];
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  capOverrideCents: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export async function loadOrgBilling(tx: Tx): Promise<OrgBilling | null> {
  const [o] = await tx
    .select({
      id: organizations.id,
      plan: organizations.plan,
      status: organizations.billingStatus,
      trialEndsAt: organizations.trialEndsAt,
      pastDueSince: organizations.pastDueSince,
      capOverrideCents: organizations.monthlySpendCapCents,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations);
  return o ?? null;
}

export function orgEntitlements(o: OrgBilling, now: Date): Entitlements {
  return entitlements(
    { plan: o.plan, status: o.status, trialEndsAt: o.trialEndsAt, pastDueSince: o.pastDueSince },
    now,
  );
}

/** Tickets with any SLA cycle live during the period (see `cycleLiveIn`). */
export async function countTrackedTickets(tx: Tx, p: Period): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${slaOutcomes.ticketId})::int` })
    .from(slaOutcomes)
    .where(
      sql`${slaOutcomes.startedAt} < ${p.end.toISOString()}::timestamptz
          and (${slaOutcomes.stoppedAt} is null or ${slaOutcomes.stoppedAt} >= ${p.start.toISOString()}::timestamptz)`,
    );
  return row?.n ?? 0;
}

export async function creditsUsed(tx: Tx, p: Period): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${usageLedger.credits}), 0)::int` })
    .from(usageLedger)
    .where(and(gte(usageLedger.createdAt, p.start), lt(usageLedger.createdAt, p.end)));
  return row?.n ?? 0;
}

/**
 * Purchased credits available to the period: every grant made before it ends,
 * minus what earlier periods drew from purchased credits. Purchased credits
 * do not expire.
 */
export async function purchasedCreditsAvailable(tx: Tx, p: Period): Promise<number> {
  const [granted] = await tx
    .select({ n: sql<number>`coalesce(sum(${creditGrants.credits}), 0)::int` })
    .from(creditGrants)
    .where(lt(creditGrants.createdAt, p.end));
  const [drawn] = await tx
    .select({ n: sql<number>`coalesce(sum(${billingPeriods.purchasedCreditsUsed}), 0)::int` })
    .from(billingPeriods)
    .where(lt(billingPeriods.periodStart, p.start));
  return Math.max(0, (granted?.n ?? 0) - (drawn?.n ?? 0));
}

export interface CreditState {
  entitlements: Entitlements;
  used: number;
  purchasedAvailable: number;
  balance: CreditBalance;
}

/** The credit side only (no ticket count): cheap enough for every dispatch decision. */
export async function creditState(
  tx: Tx,
  o: OrgBilling,
  now: Date,
  p: Period = billingPeriod(now),
): Promise<CreditState> {
  const ent = orgEntitlements(o, now);
  const [used, purchasedAvailable] = await Promise.all([creditsUsed(tx, p), purchasedCreditsAvailable(tx, p)]);
  const balance = creditBalance({
    used,
    included: ent.includedCredits,
    purchasedAvailable,
    capOverrideCents: o.capOverrideCents,
    overageAllowed: ent.overageBilled,
  });
  return { entitlements: ent, used, purchasedAvailable, balance };
}

export interface PeriodUsage extends CreditState {
  period: Period;
  tracked: number;
  trackedLimit: number | null;
  ticketOverage: number;
  /** Billable overage in cents; 0 when overage is only flagged (trial, canceled, degraded). */
  ticketOverageCents: number;
  creditOverageCents: number;
}

export async function periodUsage(
  tx: Tx,
  o: OrgBilling,
  now: Date,
  p: Period = billingPeriod(now),
): Promise<PeriodUsage> {
  const credit = await creditState(tx, o, now, p);
  const ent = credit.entitlements;
  const tracked = await countTrackedTickets(tx, p);
  const ticketOverage = trackedOverage(tracked, ent.trackedTicketLimit);
  const billed = ent.overageBilled;
  return {
    ...credit,
    period: p,
    tracked,
    trackedLimit: ent.trackedTicketLimit,
    ticketOverage,
    ticketOverageCents: billed ? ticketOverage * (ent.plan.ticketOverageCents ?? 0) : 0,
    creditOverageCents: billed && ent.plan.creditOverage ? credit.balance.overage : 0,
  };
}
