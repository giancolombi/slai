/**
 * The billing snapshot job (T-65). For one org it:
 * - closes the previous calendar month: the final tracked-ticket and credit
 *   snapshot in `billing_periods`, and reports billable overage to Stripe once
 *   (Billing Meter events) when a subscription exists;
 * - refreshes the open month's snapshot;
 * - sends the owner each billing notice once: tracked tickets over the plan,
 *   trial ending (3 days) and ended, and agents degraded after a failed payment.
 *
 * It never changes monitoring: the entitlements it reports only cap agents.
 */
import {
  audit,
  billingPeriods,
  loadOrgBilling,
  memberships,
  organizations,
  type PeriodUsage,
  periodUsage,
  type Tx,
  users,
} from "@slai/db";
import { billingPeriod, planOf, TRIAL } from "@slai/shared";
import { eq, sql } from "drizzle-orm";
import { monthKey } from "./clock.js";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";
import type { Message } from "./notify.js";

/** Reports usage to the payment provider (Stripe Billing Meters). Null in manual billing mode. */
export interface UsageReporter {
  reportMeterEvent(e: {
    eventName: string;
    customerId: string;
    value: number;
    /** Idempotency: the provider drops a repeat of the same identifier. */
    identifier: string;
    timestamp: Date;
  }): Promise<void>;
}

export const DEFAULT_METERS = {
  trackedTickets: "slai_tracked_ticket_overage",
  credits: "slai_credit_overage",
} as const;

const SYSTEM = { type: "system" as const, id: null, name: "slai" };

type PeriodRow = typeof billingPeriods.$inferSelect;

async function upsertPeriod(tx: Tx, orgId: string, plan: string, u: PeriodUsage, closedAt: Date | null) {
  const values = {
    plan,
    periodEnd: u.period.end,
    trackedTickets: u.tracked,
    trackedLimit: u.trackedLimit,
    ticketOverage: u.ticketOverage,
    creditsUsed: u.used,
    includedCredits: u.entitlements.includedCredits,
    purchasedCreditsUsed: u.balance.fromPurchased,
    creditOverage: u.balance.overage,
    overageCents: u.ticketOverageCents + u.creditOverageCents,
    closedAt,
  };
  const [row] = await tx
    .insert(billingPeriods)
    .values({ orgId, periodStart: u.period.start, ...values })
    .onConflictDoUpdate({ target: [billingPeriods.orgId, billingPeriods.periodStart], set: values })
    .returning();
  return row!;
}

/** Records `action` once per `key` (an audit event); true the first time. */
async function once(
  tx: Tx,
  orgId: string,
  action: string,
  key: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  const seen = await tx.execute(
    sql`select 1 from audit_events where action = ${action} and metadata->>'key' = ${key} limit 1`,
  );
  if (seen.length) return false;
  await audit(tx, {
    orgId,
    actor: SYSTEM,
    action,
    target: { type: "organization", id: orgId },
    metadata: { key, ...metadata },
  });
  return true;
}

interface Notice extends Message {
  action: string;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function billingSnapshotJob(deps: WorkerDeps, payload: { orgId: string }): Promise<void> {
  const { orgId } = payload;
  const now = deps.clock.now();
  const cur = billingPeriod(now);
  const prev = billingPeriod(new Date(cur.start.getTime() - 1));
  const link = `${deps.config.appUrl}/billing`;

  const out = await deps.orgDb.withOrg(orgId, async (tx) => {
    const org = await loadOrgBilling(tx);
    if (!org) return null;
    const [meta] = await tx.select({ createdAt: organizations.createdAt }).from(organizations);
    const notices: Notice[] = [];

    // ---- close the previous month ----
    let toReport: PeriodRow | null = null;
    const [prevRow] = await tx.select().from(billingPeriods).where(eq(billingPeriods.periodStart, prev.start));
    if (meta && meta.createdAt < prev.end && !prevRow?.closedAt) {
      // Entitlements as they stood at the end of that month (e.g. a trial still running then).
      const u = await periodUsage(tx, org, new Date(prev.end.getTime() - 1), prev);
      const row = await upsertPeriod(tx, orgId, org.plan, u, now);
      await audit(tx, {
        orgId,
        actor: SYSTEM,
        action: "billing.period_closed",
        target: { type: "billing_period", id: row.id },
        metadata: {
          month: monthKey(prev.start),
          trackedTickets: row.trackedTickets,
          ticketOverage: row.ticketOverage,
          creditsUsed: row.creditsUsed,
          creditOverage: row.creditOverage,
          overageCents: row.overageCents,
        },
      });
      toReport = row;
    } else if (prevRow?.closedAt) {
      toReport = prevRow;
    }
    if (toReport && (toReport.reportedAt || toReport.overageCents <= 0 || !org.stripeCustomerId)) toReport = null;

    // ---- refresh the open month ----
    const u = await periodUsage(tx, org, now, cur);
    await upsertPeriod(tx, orgId, org.plan, u, null);
    const ent = u.entitlements;

    // ---- notices, each once ----
    const month = monthKey(cur.start);
    if (
      u.ticketOverage > 0 &&
      (await once(tx, orgId, "billing.tracked_overage", month, {
        month,
        trackedTickets: u.tracked,
        limit: u.trackedLimit,
        overage: u.ticketOverage,
        overageCents: u.ticketOverageCents,
      }))
    ) {
      const billed = u.ticketOverageCents > 0;
      notices.push({
        action: "billing.tracked_overage",
        subject: `[slai] ${u.tracked.toLocaleString("en-US")} SLA-tracked tickets this month, over your plan's ${u.trackedLimit?.toLocaleString("en-US")}`,
        text: [
          `This month ${u.tracked.toLocaleString("en-US")} tickets had a live SLA clock; the ${ent.plan.name} plan includes ${u.trackedLimit?.toLocaleString("en-US")}.`,
          "SLA monitoring and alerts continue for every ticket.",
          billed
            ? `Each extra tracked ticket is billed at ${money(ent.plan.ticketOverageCents ?? 0)} (${money(u.ticketOverageCents)} so far). A larger plan may cost less.`
            : "Overage is not billed on your current plan; choose a plan to keep going.",
          "",
          link,
        ].join("\n"),
      });
    }
    const trialKey = org.trialEndsAt?.toISOString() ?? "none";
    if (
      ent.state === "trialing" &&
      (ent.trialDaysLeft ?? 0) <= TRIAL.warnDaysBefore &&
      (await once(tx, orgId, "billing.trial_ending", trialKey, { trialEndsAt: trialKey, daysLeft: ent.trialDaysLeft }))
    ) {
      notices.push({
        action: "billing.trial_ending",
        subject: `[slai] Your trial ends in ${ent.trialDaysLeft} day${ent.trialDaysLeft === 1 ? "" : "s"}`,
        text: `Choose a plan to keep AI triage and drafts running. Without one, slai keeps monitoring your SLAs and alerting, but agents stop.\n\n${link}`,
      });
    }
    if (
      ent.state === "trial_expired" &&
      (await once(tx, orgId, "billing.trial_expired", trialKey, { trialEndsAt: trialKey }))
    ) {
      notices.push({
        action: "billing.trial_expired",
        subject: "[slai] Your trial has ended: agents are paused, alerts continue",
        text: `SLA monitoring and alerts continue. Choose a plan to turn triage and drafts back on.\n\n${link}`,
      });
    }
    const dueKey = org.pastDueSince?.toISOString() ?? "none";
    if (ent.state === "degraded" && (await once(tx, orgId, "billing.degraded", dueKey, { pastDueSince: dueKey }))) {
      notices.push({
        action: "billing.degraded",
        subject: "[slai] Payment past due: agents are paused, alerts continue",
        text: `We could not collect your last payment, and the grace period has ended. SLA monitoring and alerts continue; agents are paused until the payment method is updated.\n\n${link}`,
      });
    }
    return { notices, toReport, customerId: org.stripeCustomerId };
  });
  if (!out) return;

  if (out.toReport && out.customerId && deps.usageReporter) {
    await reportPeriod(deps, orgId, out.customerId, out.toReport);
  }
  for (const n of out.notices) await notifyOwners(deps, orgId, n);
}

/** Sends a closed period's billable overage to Stripe as meter events, then marks it reported. */
async function reportPeriod(deps: WorkerDeps, orgId: string, customerId: string, row: PeriodRow): Promise<void> {
  const reporter = deps.usageReporter!;
  const meters = deps.config.meters ?? DEFAULT_METERS;
  // Inside the period, so Stripe bills it with that month's usage.
  const timestamp = new Date(row.periodEnd.getTime() - 1000);
  const month = monthKey(row.periodStart);
  const plan = planOf(row.plan);
  const events = [
    {
      eventName: meters.trackedTickets,
      value: row.ticketOverage,
      kind: "tickets",
      billed: plan.ticketOverageCents !== null,
    },
    { eventName: meters.credits, value: row.creditOverage, kind: "credits", billed: plan.creditOverage },
  ].filter((e) => e.billed && e.value > 0);
  try {
    for (const e of events) {
      await reporter.reportMeterEvent({
        eventName: e.eventName,
        customerId,
        value: e.value,
        identifier: `${orgId}:${month}:${e.kind}`,
        timestamp,
      });
    }
  } catch (err) {
    deps.logger.warn({ orgId, month, err: errorMessage(err) }, "usage report failed; retried on the next snapshot");
    return;
  }
  await deps.orgDb.withOrg(orgId, async (tx) => {
    await tx.update(billingPeriods).set({ reportedAt: deps.clock.now() }).where(eq(billingPeriods.id, row.id));
    await audit(tx, {
      orgId,
      actor: SYSTEM,
      action: "billing.usage_reported",
      target: { type: "billing_period", id: row.id },
      metadata: { month, plan: plan.id, events: events.map((e) => ({ meter: e.eventName, value: e.value })) },
    });
  });
}

/** Emails each owner of the org and records the delivery (like channel notifications). */
async function notifyOwners(deps: WorkerDeps, orgId: string, n: Notice): Promise<void> {
  const owners = await deps.orgDb.withOrg(orgId, (tx) =>
    tx
      .select({ id: users.id, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.role, "owner")),
  );
  for (const o of owners) {
    let error: string | null = null;
    try {
      await deps.mailer.send({ to: o.email, subject: n.subject, text: n.text });
    } catch (e) {
      error = errorMessage(e);
      deps.logger.warn({ orgId, userId: o.id, err: error }, "billing notice failed");
    }
    await deps.orgDb.withOrg(orgId, (tx) =>
      audit(tx, {
        orgId,
        actor: SYSTEM,
        action: error ? "notification.failed" : "notification.sent",
        target: { type: "organization", id: orgId },
        metadata: { notice: n.action, channelKind: "email", recipient: "owner", userId: o.id, ...(error && { error }) },
      }),
    );
  }
}
