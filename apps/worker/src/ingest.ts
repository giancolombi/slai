/**
 * Ingest and evaluation (specs/technical.md "Data flow for one ticket", steps 2–3).
 *
 * - `persistTicket` upserts a ticket, its canonical events (idempotent on
 *   `idempotency_key`) and comments, and resolves its customer and policy.
 * - `evaluateStored` re-evaluates from stored events only, stores the
 *   evaluation and per-cycle outcomes, and sets the timer (`next_check_at`).
 *
 * Both run inside the caller's `withOrg` transaction.
 */
import type { TicketWithHistory } from "@slai/connectors";
import {
  customerAccounts,
  notifyEvent,
  slaOutcomes,
  slaPolicies,
  type Tx,
  ticketComments,
  ticketEvents,
  tickets,
  toEngineEvents,
  toStoredEvaluation,
} from "@slai/db";
import {
  CLOSED_STATUSES,
  EvaluationError,
  evaluateTicket,
  nextTransitionAt,
  parsePolicy,
  type RiskLevel,
  type SlaPolicy,
  type TicketEvaluation,
  type TicketEvent,
} from "@slai/sla-engine";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { matchCustomerAccount, resolvePolicyId } from "./decide.js";

export type TicketRow = typeof tickets.$inferSelect;

const CHUNK = 500;

async function resolveAccountAndPolicy(tx: Tx, requester: TicketWithHistory["ticket"]["requester"]) {
  const [accounts, active] = await Promise.all([
    tx
      .select({
        id: customerAccounts.id,
        domains: customerAccounts.domains,
        externalOrgIds: customerAccounts.externalOrgIds,
        policyId: customerAccounts.policyId,
      })
      .from(customerAccounts),
    tx
      .select({ id: slaPolicies.id, isDefault: slaPolicies.isDefault })
      .from(slaPolicies)
      .where(eq(slaPolicies.status, "active")),
  ]);
  const activeIds = new Set(active.map((p) => p.id));
  // Only an active policy can govern tickets; an account pointing elsewhere falls back to the default.
  const candidates = accounts.map((a) => ({
    ...a,
    policyId: a.policyId && activeIds.has(a.policyId) ? a.policyId : null,
  }));
  const account = matchCustomerAccount({ email: requester.email, orgSourceId: requester.orgSourceId }, candidates);
  const defaultId = active.find((p) => p.isDefault)?.id ?? null;
  return { customerAccountId: account?.id ?? null, policyId: resolvePolicyId(account, defaultId) };
}

/** Upserts the ticket with its history. Returns the ticket id. */
export async function persistTicket(
  tx: Tx,
  orgId: string,
  connectionId: string,
  h: TicketWithHistory,
): Promise<string> {
  const t = h.ticket;
  const { customerAccountId, policyId } = await resolveAccountAndPolicy(tx, t.requester);
  const values = {
    displayKey: t.ref.displayKey,
    url: t.ref.url,
    subject: t.subject,
    requesterName: t.requester.name,
    requesterEmail: t.requester.email,
    requesterExternalId: t.requester.sourceId,
    requesterOrgExternalId: t.requester.orgSourceId,
    customerAccountId,
    policyId,
    status: t.status,
    priority: t.priority,
    rawStatus: t.rawStatus,
    rawPriority: t.rawPriority,
    assigneeExternalId: t.assignee?.sourceId ?? null,
    assigneeName: t.assignee?.name ?? null,
    tags: t.tags,
    createdAtSource: t.createdAt,
    updatedAtSource: t.updatedAt,
  };
  const [row] = await tx
    .insert(tickets)
    .values({ orgId, connectionId, externalId: t.ref.sourceId, ...values })
    .onConflictDoUpdate({ target: [tickets.connectionId, tickets.externalId], set: values })
    .returning({ id: tickets.id });
  const ticketId = row!.id;

  const events = h.events.map(({ type, at, idempotencyKey, ...payload }) => ({
    orgId,
    ticketId,
    idempotencyKey,
    type,
    at,
    payload,
  }));
  for (let i = 0; i < events.length; i += CHUNK) {
    await tx
      .insert(ticketEvents)
      .values(events.slice(i, i + CHUNK))
      // Same key, same source event. Only the mapped payload can differ (the connection's
      // status/priority mapping changed, T-25), so a re-ingest rewrites it and the clock recomputes.
      .onConflictDoUpdate({
        target: [ticketEvents.ticketId, ticketEvents.idempotencyKey],
        set: { payload: sql`excluded.payload` },
        setWhere: sql`${ticketEvents.payload} is distinct from excluded.payload`,
      });
  }

  const comments = h.comments.map((c) => ({
    orgId,
    ticketId,
    sourceId: c.sourceId,
    at: c.at,
    authorRole: c.authorRole,
    authorName: c.authorName,
    authorExternalId: c.authorSourceId,
    public: c.public,
    body: c.bodyText,
  }));
  for (let i = 0; i < comments.length; i += CHUNK) {
    await tx
      .insert(ticketComments)
      .values(comments.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [ticketComments.ticketId, ticketComments.sourceId],
        set: { body: sql`excluded.body`, public: sql`excluded.public` },
      });
  }
  return ticketId;
}

export interface Evaluated {
  ticket: TicketRow;
  /** Null for a ticket evaluated for the first time. */
  prevRisk: RiskLevel | null;
  risk: RiskLevel;
  open: boolean;
  policy: SlaPolicy | null;
  evaluation: TicketEvaluation | null;
  events: TicketEvent[];
}

export async function loadPolicy(tx: Tx, policyId: string | null): Promise<SlaPolicy | null> {
  if (!policyId) return null;
  const [p] = await tx
    .select({ id: slaPolicies.id, definition: slaPolicies.definition })
    .from(slaPolicies)
    .where(eq(slaPolicies.id, policyId));
  if (!p) return null;
  // Stored definitions were validated on write; re-parse (the SLA clock trusts only validated input) and pin the id.
  return parsePolicy({ ...(p.definition as object), id: p.id });
}

/**
 * Re-evaluates a ticket from its stored events at `now` and persists the
 * result. Locks the ticket row so concurrent evaluations serialize, which
 * makes the previous-vs-new risk comparison (and so each crossing) exact.
 */
export async function evaluateStored(tx: Tx, orgId: string, ticketId: string, now: Date): Promise<Evaluated | null> {
  const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for("update");
  if (!ticket) return null;
  const prevRisk: RiskLevel | null = ticket.evaluation === null ? null : ticket.risk;
  const open = !CLOSED_STATUSES.includes(ticket.status);
  const rows = await tx
    .select({ type: ticketEvents.type, at: ticketEvents.at, payload: ticketEvents.payload })
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticketId))
    .orderBy(asc(ticketEvents.at), asc(ticketEvents.id));
  const events = toEngineEvents(rows);
  const policy = await loadPolicy(tx, ticket.policyId);

  let evaluation: TicketEvaluation | null = null;
  if (policy) {
    try {
      evaluation = evaluateTicket(policy, events, now);
    } catch (e) {
      if (!(e instanceof EvaluationError)) throw e;
    }
  }

  if (!evaluation || !policy) {
    await tx.delete(slaOutcomes).where(eq(slaOutcomes.ticketId, ticketId));
    const [updated] = await tx
      .update(tickets)
      .set({ evaluation: null, risk: "ok", nextDueAt: null, nextCheckAt: null, lastEvaluatedAt: now })
      .where(eq(tickets.id, ticketId))
      .returning();
    await notifyEvent(tx, { orgId, type: "ticket.updated", id: ticketId });
    return { ticket: updated!, prevRisk, risk: "ok", open, policy, evaluation: null, events };
  }

  const outcomes = evaluation.metrics.flatMap((m) =>
    m.cycles.map((c, cycleIndex) => ({
      orgId,
      ticketId,
      policyId: policy.id,
      metric: m.metric,
      cycleIndex,
      priority: m.priority,
      state: c.state,
      startedAt: c.startedAt,
      stoppedAt: c.stoppedAt,
      breachAt: c.breachAt,
      targetMs: c.targetMs,
      elapsedMs: c.elapsedMs,
      updatedAt: now,
    })),
  );
  if (outcomes.length) {
    await tx
      .insert(slaOutcomes)
      .values(outcomes)
      .onConflictDoUpdate({
        target: [slaOutcomes.ticketId, slaOutcomes.metric, slaOutcomes.cycleIndex],
        set: {
          policyId: sql`excluded.policy_id`,
          priority: sql`excluded.priority`,
          state: sql`excluded.state`,
          startedAt: sql`excluded.started_at`,
          stoppedAt: sql`excluded.stopped_at`,
          breachAt: sql`excluded.breach_at`,
          targetMs: sql`excluded.target_ms`,
          elapsedMs: sql`excluded.elapsed_ms`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  // Cycles that no longer exist (e.g. a priority change removed a target) are dropped.
  const keep = outcomes.map((o) => `${o.metric}:${o.cycleIndex}`);
  await tx
    .delete(slaOutcomes)
    .where(
      and(
        eq(slaOutcomes.ticketId, ticketId),
        keep.length
          ? notInArray(sql`${slaOutcomes.metric}::text || ':' || ${slaOutcomes.cycleIndex}::text`, keep)
          : undefined,
      ),
    );

  const dues = evaluation.metrics.map((m) => m.dueAt).filter((d): d is Date => d !== null);
  const nextDueAt = dues.length ? new Date(Math.min(...dues.map((d) => d.getTime()))) : null;
  const [updated] = await tx
    .update(tickets)
    .set({
      evaluation: toStoredEvaluation(evaluation),
      risk: evaluation.risk,
      nextDueAt,
      nextCheckAt: nextTransitionAt(policy, evaluation),
      lastEvaluatedAt: now,
    })
    .where(eq(tickets.id, ticketId))
    .returning();
  await notifyEvent(tx, { orgId, type: "ticket.updated", id: ticketId });
  return { ticket: updated!, prevRisk, risk: evaluation.risk, open, policy, evaluation, events };
}

/** Existing (externalId → updatedAtSource) for a page of tickets, to skip unchanged ones. */
export async function knownUpdates(tx: Tx, connectionId: string, externalIds: string[]) {
  if (!externalIds.length) return new Map<string, Date>();
  const rows = await tx
    .select({ externalId: tickets.externalId, updatedAtSource: tickets.updatedAtSource })
    .from(tickets)
    .where(and(eq(tickets.connectionId, connectionId), inArray(tickets.externalId, externalIds)));
  return new Map(rows.map((r) => [r.externalId, r.updatedAtSource]));
}
