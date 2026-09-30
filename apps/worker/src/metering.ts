/**
 * Usage metering (TR-30) and the monthly spend cap (PR-23). Every model call,
 * sandbox second, and billable action is appended to `usage_ledger` in the
 * same transaction as the run it belongs to.
 *
 * Billing is in credits (1 credit = 1 cent): triage 3, draft 20, autopilot
 * reply 60 (specs/product.md §4). Model cost is recorded alongside, in
 * micro-dollars, for margin reporting; it does not count against the cap.
 */
import type { RunMetering } from "@slai/agents";
import { audit, creditState, loadOrgBilling, type Tx, usageLedger } from "@slai/db";
import { ACTION_CREDITS, type AgentCeiling } from "@slai/shared";
import { gte, sql } from "drizzle-orm";
import { monthKey, monthStart } from "./clock.js";
import { type SpendState, spendState } from "./decide.js";

export const CAP_THRESHOLDS = [50, 80, 100] as const;

export interface LedgerRef {
  ticketId?: string | null;
  agentRunId?: string | null;
  contractId?: string | null;
  replayId?: string | null;
}

export async function creditsThisMonth(tx: Tx, now: Date): Promise<number> {
  const [row] = await tx
    .select({ credits: sql<number>`coalesce(sum(${usageLedger.credits}), 0)::int` })
    .from(usageLedger)
    .where(gte(usageLedger.createdAt, monthStart(now)));
  return row?.credits ?? 0;
}

export interface BillingGate {
  /** The plan's agent ceiling now (T-65): trial, past due and canceled states lower it. */
  ceiling: AgentCeiling;
  spend: SpendState;
  usedCredits: number;
  /** The spend cap in credits (included + purchased + allowance, or the owner's override). */
  capCredits: number | null;
}

/** The plan ceiling and spend state for dispatch decisions. */
export async function currentBilling(tx: Tx, now: Date): Promise<BillingGate> {
  const org = await loadOrgBilling(tx);
  if (!org) return { ceiling: "observe", spend: "ok", usedCredits: 0, capCredits: null };
  const cs = await creditState(tx, org, now);
  return {
    ceiling: cs.entitlements.ceiling,
    spend: spendState(cs.used, cs.balance.cap),
    usedCredits: cs.used,
    capCredits: cs.balance.cap,
  };
}

export async function currentSpend(tx: Tx, now: Date): Promise<SpendState> {
  return (await currentBilling(tx, now)).spend;
}

/**
 * Appends a run's metering: one row per model call (the first carries the
 * action's credits, and only if the run succeeded) and one for sandbox seconds.
 */
export async function meterRun(
  tx: Tx,
  orgId: string,
  now: Date,
  metering: RunMetering,
  credits: number,
  ref: LedgerRef,
): Promise<void> {
  const rows: (typeof usageLedger.$inferInsert)[] = metering.usage.map((u, i) => ({
    orgId,
    kind: "model_call",
    quantity: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    unit: "tokens",
    costMicros: u.costMicros,
    credits: i === 0 ? credits : 0,
    createdAt: now,
    ...refs(ref),
  }));
  if (rows.length === 0 && credits > 0) {
    rows.push({ orgId, kind: "model_call", quantity: 0, unit: "tokens", credits, createdAt: now, ...refs(ref) });
  }
  if (metering.sandbox) {
    rows.push({
      orgId,
      kind: "sandbox_seconds",
      quantity: Math.ceil(metering.sandbox.seconds),
      unit: "seconds",
      createdAt: now,
      ...refs(ref),
    });
  }
  if (rows.length) await tx.insert(usageLedger).values(rows);
}

export async function meterAction(tx: Tx, orgId: string, now: Date, kind: "autopilot_reply", ref: LedgerRef) {
  await tx.insert(usageLedger).values({
    orgId,
    kind,
    quantity: 1,
    unit: "replies",
    credits: ACTION_CREDITS[kind],
    createdAt: now,
    ...refs(ref),
  });
}

function refs(r: LedgerRef) {
  return {
    ticketId: r.ticketId ?? null,
    agentRunId: r.agentRunId ?? null,
    contractId: r.contractId ?? null,
    replayId: r.replayId ?? null,
  };
}

/**
 * Records each spend-cap threshold (50/80/100%) reached this month that was
 * not recorded yet, and returns them so the caller can notify after commit.
 * Recorded as audit events, so each fires once per month.
 */
export async function reachedCapThresholds(tx: Tx, orgId: string, now: Date): Promise<number[]> {
  const { capCredits: cap, usedCredits: credits } = await currentBilling(tx, now);
  if (cap === null || cap <= 0) return [];
  const month = monthKey(now);
  const reached = CAP_THRESHOLDS.filter((p) => credits * 100 >= cap * p);
  if (!reached.length) return [];
  const done = await tx.execute<{ percent: string }>(
    sql`select metadata->>'percent' as percent from audit_events
        where action = 'usage.cap_threshold' and metadata->>'month' = ${month}`,
  );
  const seen = new Set([...done].map((r) => Number(r.percent)));
  const fresh = reached.filter((p) => !seen.has(p));
  for (const percent of fresh) {
    await audit(tx, {
      orgId,
      actor: { type: "system", id: null, name: "slai" },
      action: "usage.cap_threshold",
      target: { type: "organization", id: orgId },
      metadata: { month, percent, creditsUsed: credits, capCredits: cap },
    });
  }
  return fresh;
}
