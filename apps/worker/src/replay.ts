/**
 * Breach Replay (T-45, PR-22): replays the last N days of a connection against
 * the policies and reports breaches, attainment, dollar exposure, and the
 * warning slai would have given. Every figure comes from the SLA engine.
 *
 * Replayed tickets are also stored (idempotent ingest), so the product has
 * data immediately. A replay is analysis only: it sends no alerts and
 * dispatches no agents.
 */
import { type ConnectorClient, ConnectorError, type TicketWithHistory } from "@slai/connectors";
import { customerAccounts, notifyEvent, replays } from "@slai/db";
import {
  computeAttainment,
  computeCredits,
  METRICS,
  type Metric,
  type SlaPolicy,
  type TicketEvaluation,
} from "@slai/sla-engine";
import { eq } from "drizzle-orm";
import { monthKey } from "./clock.js";
import { clientFor, loadConnection, markConnectionError, recordMappingIssues } from "./connection.js";
import type { WorkerDeps } from "./deps.js";
import { evaluateStored, persistTicket } from "./ingest.js";
import { median, warningLeadMs } from "./lead.js";
import { errorMessage } from "./logger.js";

const DAY_MS = 86_400_000;
const PROGRESS_EVERY = 25;
const MAX_RETRIES = 5;
const MAX_WAIT_MS = 60_000;

export interface ReplayResult {
  tickets: number;
  breaches: number;
  attainmentPercent: number | null;
  exposureCents: number;
  byCustomer: { customerId: string | null; name: string; breaches: number; exposureCents: number }[];
  byMetric: { metric: Metric; breaches: number; measured: number }[];
  medianLeadMinutes: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries rate-limited calls after the help desk's Retry-After (bounded). */
async function politely<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ConnectorError) || e.kind !== "rate_limited" || attempt >= MAX_RETRIES) throw e;
      await sleep(Math.min(MAX_WAIT_MS, e.retryAfterMs ?? 1000 * 2 ** attempt));
    }
  }
}

interface Replayed {
  customerAccountId: string | null;
  createdAt: Date;
  policy: SlaPolicy;
  evaluation: TicketEvaluation;
  events: Parameters<typeof warningLeadMs>[1];
}

export function summarize(
  items: Replayed[],
  accounts: Map<string, { name: string; fee: number | null }>,
): ReplayResult {
  const evals = items.map((i) => i.evaluation);
  const overall = computeAttainment(evals);

  // Exposure: each customer's credit clauses, per calendar month (the billing period), against its fee.
  const groups = new Map<string, Replayed[]>();
  for (const i of items) {
    const key = `${i.customerAccountId ?? ""}|${i.policy.id}|${monthKey(i.createdAt)}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const byCustomer = new Map<string | null, { breaches: number; exposureCents: number }>();
  for (const group of groups.values()) {
    const first = group[0]!;
    const fee = (first.customerAccountId && accounts.get(first.customerAccountId)?.fee) || 0;
    const credits = computeCredits(
      first.policy.credits,
      group.map((g) => g.evaluation),
      fee,
    );
    const c = byCustomer.get(first.customerAccountId) ?? { breaches: 0, exposureCents: 0 };
    c.breaches += computeAttainment(group.map((g) => g.evaluation)).breached;
    c.exposureCents += credits.totalCents;
    byCustomer.set(first.customerAccountId, c);
  }

  const leads: number[] = [];
  for (const i of items) {
    for (const m of i.evaluation.metrics) {
      for (const c of m.cycles) {
        const lead = warningLeadMs(i.policy, i.events, m.metric, c);
        if (lead !== null) leads.push(lead);
      }
    }
  }
  const med = median(leads);

  return {
    tickets: items.length,
    breaches: overall.breached,
    attainmentPercent: overall.percent,
    exposureCents: [...byCustomer.values()].reduce((s, c) => s + c.exposureCents, 0),
    byCustomer: [...byCustomer.entries()]
      .map(([id, c]) => ({
        customerId: id,
        name: id ? (accounts.get(id)?.name ?? "Unknown customer") : "Unmatched (default policy)",
        ...c,
      }))
      .sort((a, b) => b.exposureCents - a.exposureCents || b.breaches - a.breaches),
    byMetric: METRICS.map((metric) => {
      const a = computeAttainment(evals, { metric, priority: null });
      return { metric, breaches: a.breached, measured: a.measured };
    }),
    medianLeadMinutes: med === null ? null : Math.round(med / 60_000),
  };
}

export async function runReplay(deps: WorkerDeps, p: { orgId: string; replayId: string }): Promise<void> {
  const { orgId, replayId } = p;
  const startedAt = deps.clock.now();
  const prep = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [r] = await tx.select().from(replays).where(eq(replays.id, replayId)).for("update");
    if (!r || (r.status !== "queued" && r.status !== "running")) return null;
    const conn = await loadConnection(tx, r.connectionId);
    await tx.update(replays).set({ status: "running", startedAt, error: null }).where(eq(replays.id, replayId));
    await notifyEvent(tx, { orgId, type: "replay.progress", id: replayId });
    return { replay: r, conn };
  });
  if (!prep) return;
  const { replay, conn } = prep;

  const finish = async (values: Partial<typeof replays.$inferInsert>) =>
    deps.orgDb.withOrg(orgId, async (tx) => {
      await tx
        .update(replays)
        .set({ ...values, finishedAt: deps.clock.now() })
        .where(eq(replays.id, replayId));
      await notifyEvent(tx, { orgId, type: "replay.progress", id: replayId });
    });

  if (!conn) {
    await finish({ status: "failed", error: "The connection no longer exists." });
    return;
  }
  try {
    const client: ConnectorClient = clientFor(deps, conn);
    const since = new Date(startedAt.getTime() - replay.days * DAY_MS);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await politely(() => client.listUpdatedTickets(since, cursor));
      ids.push(...page.items.map((t) => t.ref.sourceId));
      cursor = page.nextCursor;
    } while (cursor);
    const sourceIds = [...new Set(ids)];
    await setProgress(deps, orgId, replayId, 0, sourceIds.length);

    const items: Replayed[] = [];
    for (const [n, sourceId] of sourceIds.entries()) {
      let h: TicketWithHistory;
      try {
        h = await politely(() => client.getTicketWithHistory(sourceId));
      } catch (e) {
        if (e instanceof ConnectorError && e.kind === "not_found") continue;
        throw e;
      }
      const ev = await deps.orgDb.withOrg(orgId, async (tx) => {
        const ticketId = await persistTicket(tx, orgId, conn.id, h);
        await recordMappingIssues(tx, conn.id, h.ticket.mappingIssues);
        return evaluateStored(tx, orgId, ticketId, deps.clock.now());
      });
      if (ev?.policy && ev.evaluation) {
        items.push({
          customerAccountId: ev.ticket.customerAccountId,
          createdAt: ev.ticket.createdAtSource,
          policy: ev.policy,
          evaluation: ev.evaluation,
          events: ev.events,
        });
      }
      if ((n + 1) % PROGRESS_EVERY === 0) await setProgress(deps, orgId, replayId, n + 1, sourceIds.length);
    }

    const accounts = await deps.orgDb.withOrg(orgId, (tx) =>
      tx
        .select({ id: customerAccounts.id, name: customerAccounts.name, fee: customerAccounts.monthlyFeeCents })
        .from(customerAccounts),
    );
    const result = summarize(items, new Map(accounts.map((a) => [a.id, { name: a.name, fee: a.fee }])));
    await finish({
      status: "succeeded",
      result,
      progress: { ticketsScanned: sourceIds.length, ticketsTotal: sourceIds.length },
    });
    deps.logger.info({ orgId, replayId, tickets: result.tickets, breaches: result.breaches }, "replay done");
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === "auth") await markConnectionError(deps, orgId, conn.id, e);
    await finish({ status: "failed", error: errorMessage(e) });
  }
}

async function setProgress(deps: WorkerDeps, orgId: string, replayId: string, scanned: number, total: number) {
  await deps.orgDb.withOrg(orgId, async (tx) => {
    await tx
      .update(replays)
      .set({ progress: { ticketsScanned: scanned, ticketsTotal: total } })
      .where(eq(replays.id, replayId));
    await notifyEvent(tx, { orgId, type: "replay.progress", id: replayId });
  });
}
