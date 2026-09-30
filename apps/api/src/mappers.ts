/** Row → DTO mappers (packages/shared types). Nothing secret ever leaves through here. */
import type { StoredEvaluation, StoredMetric, schema } from "@slai/db";
import type {
  AgentAction,
  AgentRun,
  Contract,
  CustomerAccount,
  KnowledgeRef,
  Metric,
  MetricView,
  Policy,
  Replay,
  TicketSummary,
} from "@slai/shared";
import { z } from "zod";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toPolicy(p: Row<typeof schema.slaPolicies>): Policy {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    status: p.status,
    contractId: p.contractId,
    isDefault: p.isDefault,
    definition: p.definition,
    approvedBy: p.approvedBy,
    approvedAt: iso(p.approvedAt),
    createdAt: p.createdAt.toISOString(),
  };
}

export function toCustomer(
  c: Row<typeof schema.customerAccounts>,
  stats: { openTickets: number; atRiskTickets: number; breachesThisPeriod: number },
): CustomerAccount {
  return {
    id: c.id,
    name: c.name,
    domains: c.domains,
    externalOrgIds: c.externalOrgIds,
    monthlyFeeCents: c.monthlyFeeCents,
    policyId: c.policyId,
    ...stats,
  };
}

export function toContract(c: Row<typeof schema.contracts>, uploadedBy: string | null, policyIds: string[]): Contract {
  const x = (c.extraction ?? null) as Partial<NonNullable<Contract["extraction"]>> | null;
  return {
    id: c.id,
    filename: c.filename,
    customerAccountId: c.customerAccountId,
    status: c.status,
    uploadedAt: c.createdAt.toISOString(),
    uploadedBy: uploadedBy ?? "",
    error: c.error,
    extraction: x
      ? { summary: x.summary ?? "", policyIds, ambiguities: x.ambiguities ?? [], citations: x.citations ?? [] }
      : null,
  };
}

export function toAgentRun(r: Row<typeof schema.agentRuns>): AgentRun {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    model: r.model,
    costCents: Math.round(r.costMicros / 10_000),
    sandboxSeconds: r.sandboxSeconds,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    error: r.error,
    output: r.output,
  };
}

export function toAgentAction(
  a: Row<typeof schema.agentActions>,
  ticket: { displayKey: string; subject: string },
): AgentAction {
  return {
    id: a.id,
    ticketId: a.ticketId,
    ticketKey: ticket.displayKey,
    ticketSubject: ticket.subject,
    kind: a.kind,
    status: a.status,
    body: a.body,
    payload: a.payload,
    confidence: a.confidence,
    blockedReason: a.blockedReason,
    createdAt: a.createdAt.toISOString(),
    decidedBy: a.decidedBy,
    decidedAt: iso(a.decidedAt),
    usedKnowledge: usedKnowledge(a.payload),
  };
}

const knowledgeRef = z.object({
  id: z.string().nullable().catch(null),
  title: z.string(),
  url: z.string().nullable().catch(null),
});

/** The articles a draft relied on, as the worker recorded them on the action (T-47); [] when absent or malformed. */
export function usedKnowledge(payload: unknown): KnowledgeRef[] {
  const raw = (payload as { usedArticles?: unknown } | null)?.usedArticles;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const p = knowledgeRef.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

export function toReplay(r: Row<typeof schema.replays>): Replay {
  return {
    id: r.id,
    connectionId: r.connectionId,
    days: r.days,
    status: r.status,
    progress: r.progress,
    result: (r.result ?? null) as Replay["result"],
    createdAt: r.createdAt.toISOString(),
  };
}

export function toMetricView(m: StoredMetric): MetricView {
  return {
    metric: m.metric as Metric,
    state: m.state,
    targetMs: m.targetMs,
    elapsedMs: m.elapsedMs,
    remainingMs: m.remainingMs,
    dueAt: m.dueAt,
    risk: m.risk,
    breachCount: m.breachCount,
  };
}

export interface TicketListRow {
  t: Row<typeof schema.tickets>;
  provider: string;
  customerName: string | null;
  policyName: string | null;
}

export function toTicketSummary({ t, provider, customerName, policyName }: TicketListRow): TicketSummary {
  const ev = t.evaluation as StoredEvaluation | null;
  const u = ev?.mostUrgent ?? null;
  return {
    id: t.id,
    connectionId: t.connectionId,
    provider,
    displayKey: t.displayKey,
    url: t.url,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    customer: t.customerAccountId && customerName ? { id: t.customerAccountId, name: customerName } : null,
    policy: t.policyId && policyName ? { id: t.policyId, name: policyName } : null,
    risk: t.risk,
    next: u ? { metric: u.metric as Metric, dueAt: u.dueAt, remainingMs: u.remainingMs, state: u.state } : null,
    assigneeName: t.assigneeName,
    updatedAt: t.updatedAtSource.toISOString(),
  };
}
