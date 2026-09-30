import {
  agentActions,
  connections,
  countTrackedTickets,
  creditState,
  customerAccounts,
  loadOrgBilling,
  slaOutcomes,
  slaPolicies,
  type Tx,
  tickets,
  usageLedger,
} from "@slai/db";
import type { DashboardSummary, Risk, UsageSummary } from "@slai/shared";
import {
  type CreditRule,
  type CycleResult,
  computeAttainment,
  computeCredits,
  type MetricResult,
  type Priority,
  parsePolicy,
  type TicketEvaluation,
} from "@slai/sla-engine";
import { and, asc, eq, gte, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auth } from "../context.js";
import { toTicketSummary } from "../mappers.js";
import { currentPeriod } from "../org-refs.js";

type Outcome = typeof slaOutcomes.$inferSelect & { customerAccountId: string | null; ticketPolicyId: string | null };
const CLOSED = ["solved", "closed"] as const;
const DAY = 86_400_000;

/**
 * Rebuilds the engine's evaluation shape from stored per-cycle outcomes, so
 * attainment and credits come from the engine (computeAttainment/computeCredits),
 * never from ad-hoc arithmetic here.
 */
export function evalsFromOutcomes(
  rows: Pick<
    Outcome,
    "ticketId" | "metric" | "priority" | "state" | "startedAt" | "stoppedAt" | "breachAt" | "elapsedMs" | "targetMs"
  >[],
): TicketEvaluation[] {
  const byTicket = new Map<string, Map<string, MetricResult>>();
  for (const r of rows) {
    const metrics = byTicket.get(r.ticketId) ?? new Map<string, MetricResult>();
    byTicket.set(r.ticketId, metrics);
    const key = `${r.metric}:${r.priority}`;
    let m = metrics.get(key);
    if (!m) {
      m = {
        metric: r.metric,
        priority: r.priority as Priority | null,
        state: "not_applicable",
        clock: null,
        targetMs: null,
        elapsedMs: 0,
        remainingMs: null,
        dueAt: null,
        consumed: null,
        risk: "ok",
        cycles: [],
        breachCount: 0,
      };
      metrics.set(key, m);
    }
    const cycle: CycleResult = {
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      elapsedMs: r.elapsedMs,
      targetMs: r.targetMs,
      state: r.state,
      breachAt: r.breachAt,
    };
    m.cycles.push(cycle);
    if (r.state === "breached") m.breachCount++;
  }
  return [...byTicket.entries()].map(([ticketId, metrics]) => ({
    policyId: ticketId,
    evaluatedAt: new Date(0),
    priority: null,
    status: "open",
    metrics: [...metrics.values()],
    mostUrgent: null,
    risk: "ok",
  }));
}

/** Outcomes that became final (met or breached) within [start, end). */
function finalizedIn(tx: Tx, start: Date, end: Date) {
  return tx
    .select({
      o: slaOutcomes,
      customerAccountId: tickets.customerAccountId,
      ticketPolicyId: tickets.policyId,
    })
    .from(slaOutcomes)
    .innerJoin(tickets, eq(tickets.id, slaOutcomes.ticketId))
    .where(
      or(
        and(eq(slaOutcomes.state, "breached"), gte(slaOutcomes.breachAt, start), lt(slaOutcomes.breachAt, end)),
        and(eq(slaOutcomes.state, "achieved"), gte(slaOutcomes.stoppedAt, start), lt(slaOutcomes.stoppedAt, end)),
      ),
    )
    .then((rows) =>
      rows.map((r): Outcome => ({ ...r.o, customerAccountId: r.customerAccountId, ticketPolicyId: r.ticketPolicyId })),
    );
}

/** Credits owed (engine) summed over (customer, policy) groups. */
async function exposure(tx: Tx, outcomes: Outcome[]): Promise<number> {
  const policyIds = [...new Set(outcomes.map((o) => o.ticketPolicyId).filter((x): x is string => !!x))];
  if (policyIds.length === 0) return 0;
  const credits = new Map<string, CreditRule[]>();
  for (const p of await tx
    .select({ id: slaPolicies.id, definition: slaPolicies.definition })
    .from(slaPolicies)
    .where(inArray(slaPolicies.id, policyIds))) {
    try {
      credits.set(p.id, parsePolicy(p.definition).credits);
    } catch {
      credits.set(p.id, []);
    }
  }
  const fees = new Map(
    (await tx.select({ id: customerAccounts.id, fee: customerAccounts.monthlyFeeCents }).from(customerAccounts)).map(
      (r) => [r.id, r.fee ?? 0],
    ),
  );
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    if (!o.ticketPolicyId) continue;
    const key = `${o.customerAccountId ?? ""}|${o.ticketPolicyId}`;
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }
  let total = 0;
  for (const [key, rows] of groups) {
    const [customerId, policyId] = key.split("|") as [string, string];
    total += computeCredits(
      credits.get(policyId) ?? [],
      evalsFromOutcomes(rows),
      customerId ? (fees.get(customerId) ?? 0) : 0,
    ).totalCents;
  }
  return total;
}

export function dashboardRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/dashboard", async (c) => {
    const now = deps.now();
    const { start, end } = currentPeriod(now);
    const summary = await deps.orgDb.withOrg(auth(c).orgId, async (tx): Promise<DashboardSummary> => {
      const riskRows = await tx
        .select({ risk: tickets.risk, n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(notInArray(tickets.status, [...CLOSED]))
        .groupBy(tickets.risk);
      const byRisk: Record<Risk, number> = { ok: 0, warning: 0, at_risk: 0, breached: 0 };
      for (const r of riskRows) byRisk[r.risk] = r.n;

      const outcomes = await finalizedIn(tx, start, end);
      const att = computeAttainment(evalsFromOutcomes(outcomes));
      const exposureCents = await exposure(tx, outcomes);

      // Saved: a cycle met in time while a slai action was sent during it.
      const sent = await tx
        .select({ ticketId: agentActions.ticketId, at: agentActions.updatedAt })
        .from(agentActions)
        .where(and(eq(agentActions.status, "sent"), gte(agentActions.updatedAt, new Date(start.getTime() - 31 * DAY))));
      const saved = outcomes.filter(
        (o) =>
          o.state === "achieved" &&
          o.stoppedAt &&
          sent.some((s) => s.ticketId === o.ticketId && s.at >= o.startedAt && s.at <= o.stoppedAt!),
      );
      const savedIds = new Set(saved.map((o) => o.id));
      const counterfactual = outcomes.map((o) => (savedIds.has(o.id) ? { ...o, state: "breached" as const } : o));
      const savedCents = saved.length ? Math.max(0, (await exposure(tx, counterfactual)) - exposureCents) : 0;

      const due = await tx
        .select({
          t: tickets,
          provider: connections.provider,
          customerName: customerAccounts.name,
          policyName: slaPolicies.name,
        })
        .from(tickets)
        .innerJoin(connections, eq(connections.id, tickets.connectionId))
        .leftJoin(customerAccounts, eq(customerAccounts.id, tickets.customerAccountId))
        .leftJoin(slaPolicies, eq(slaPolicies.id, tickets.policyId))
        .where(and(notInArray(tickets.status, [...CLOSED]), isNotNull(tickets.nextDueAt)))
        .orderBy(asc(tickets.nextDueAt))
        .limit(10);

      const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 13 * DAY);
      const trendRows = await finalizedIn(tx, trendStart, new Date(trendStart.getTime() + 14 * DAY));
      const attainmentTrend = Array.from({ length: 14 }, (_, i) => {
        const d0 = trendStart.getTime() + i * DAY;
        const day = trendRows.filter((o) => {
          const t = (o.state === "breached" ? o.breachAt : o.stoppedAt)!.getTime();
          return t >= d0 && t < d0 + DAY;
        });
        const a = computeAttainment(evalsFromOutcomes(day));
        return { date: new Date(d0).toISOString().slice(0, 10), percent: a.percent, breaches: a.breached };
      });

      const [pending] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(agentActions)
        .where(inArray(agentActions.status, ["proposed", "blocked"]));

      return {
        period: { start: start.toISOString(), end: end.toISOString() },
        openTickets: Object.values(byRisk).reduce((s, n) => s + n, 0),
        byRisk,
        breachesThisPeriod: att.breached,
        attainmentPercent: att.percent,
        exposureCents,
        savedBreaches: saved.length,
        savedCents,
        dueSoon: due.map(toTicketSummary),
        attainmentTrend,
        pendingApprovals: pending?.n ?? 0,
      };
    });
    return c.json(summary);
  });

  app.get("/usage", async (c) => {
    const { start, end } = currentPeriod(deps.now());
    const usage = await deps.orgDb.withOrg(auth(c).orgId, async (tx): Promise<UsageSummary> => {
      const rows = await tx
        .select({
          kind: usageLedger.kind,
          count: sql<number>`count(*)::int`,
          micros: sql<number>`coalesce(sum(${usageLedger.costMicros}), 0)::bigint`,
          credits: sql<number>`coalesce(sum(${usageLedger.credits}), 0)::int`,
        })
        .from(usageLedger)
        .where(and(gte(usageLedger.createdAt, start), lt(usageLedger.createdAt, end)))
        .groupBy(usageLedger.kind);
      // The same tracked-ticket count and spend cap as billing (T-65).
      const org = await loadOrgBilling(tx);
      const credit = org ? await creditState(tx, org, deps.now(), { start, end }) : null;
      const tracked = await countTrackedTickets(tx, { start, end });
      const totalMicros = rows.reduce((s, r) => s + Number(r.micros), 0);
      return {
        period: { start: start.toISOString(), end: end.toISOString() },
        creditsUsed: rows.reduce((s, r) => s + r.credits, 0),
        costCents: Math.round(totalMicros / 10_000),
        spendCapCents: credit?.balance.cap ?? null,
        byKind: rows.map((r) => ({ kind: r.kind, count: r.count, costCents: Math.round(Number(r.micros) / 10_000) })),
        trackedTickets: tracked,
      };
    });
    return c.json(usage);
  });

  return app;
}
