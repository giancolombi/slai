/**
 * Agent runs and help-desk writes (T-43). Agents only propose; this module
 * decides what happens to each proposal and performs (and audits) every write
 * to the help desk.
 */

import { randomUUID } from "node:crypto";
import {
  type AgentRunResult,
  type DraftReplyResult,
  decideAutopilot,
  type TicketContext,
  type TriageResult,
} from "@slai/agents";
import { ConnectorError } from "@slai/connectors";
import {
  agentActions,
  agentRuns,
  audit,
  customerAccounts,
  fromStoredEvaluation,
  notifyEvent,
  type StoredEvaluation,
  type Tx,
  ticketComments,
  tickets,
} from "@slai/db";
import type { Priority } from "@slai/sla-engine";
import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { clientFor, connectorFor, loadConnection, markConnectionError } from "./connection.js";
import { type Autonomy, decideRunLevel, decideSendStep, findSentComment, resolveAutonomy } from "./decide.js";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";
import { CREDITS, currentBilling, meterAction, meterRun, reachedCapThresholds } from "./metering.js";
import { loadRules } from "./react.js";
import { notifyCapThresholds } from "./spend.js";

type TicketRow = typeof tickets.$inferSelect;
type ActionInsert = typeof agentActions.$inferInsert;

export const THREAD_LIMIT = 20;
export const MESSAGE_CHARS = 4000;

/** An article a draft relied on, as recorded on the run output and the reply action (T-47). */
export interface UsedArticle {
  id: string | null;
  title: string;
  url: string | null;
}

/** Bounded, oldest-first thread plus the SLA state the engine computed. */
export async function buildContext(tx: Tx, deps: WorkerDeps, orgId: string, t: TicketRow): Promise<TicketContext> {
  return (await buildContextWithRefs(tx, deps, orgId, t)).ctx;
}

/** The context, plus the article id behind each knowledge item (to record what a draft used). */
export async function buildContextWithRefs(
  tx: Tx,
  deps: WorkerDeps,
  orgId: string,
  t: TicketRow,
): Promise<{ ctx: TicketContext; knowledgeIds: (string | null)[] }> {
  const recent = await tx
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, t.id))
    .orderBy(desc(ticketComments.at), desc(ticketComments.id))
    .limit(THREAD_LIMIT);
  const [account] = t.customerAccountId
    ? await tx
        .select({ name: customerAccounts.name })
        .from(customerAccounts)
        .where(eq(customerAccounts.id, t.customerAccountId))
    : [];
  const ev = t.evaluation ? fromStoredEvaluation(t.evaluation as StoredEvaluation) : null;
  const lastAsk = recent.find((c) => c.authorRole === "requester" && c.public)?.body ?? null;
  const res = await deps.resources(orgId, {
    id: t.id,
    connectionId: t.connectionId,
    subject: t.subject,
    lastRequesterMessage: lastAsk ? lastAsk.slice(0, MESSAGE_CHARS) : null,
  });
  const ctx: TicketContext = {
    ticketKey: t.displayKey,
    subject: t.subject,
    priority: t.priority,
    status: t.status,
    customerName: account?.name ?? t.requesterName ?? null,
    thread: recent.reverse().map((c) => ({
      at: c.at.toISOString(),
      authorRole: c.authorRole as TicketContext["thread"][number]["authorRole"],
      authorName: c.authorName,
      public: c.public,
      body: c.body.length > MESSAGE_CHARS ? `${c.body.slice(0, MESSAGE_CHARS)}…` : c.body,
    })),
    sla: {
      risk: t.risk,
      mostUrgent: ev?.mostUrgent
        ? {
            metric: ev.mostUrgent.metric,
            remainingMs: ev.mostUrgent.remainingMs,
            dueAt: ev.mostUrgent.dueAt,
            state: ev.mostUrgent.state,
          }
        : null,
      metrics: (ev?.metrics ?? []).filter((m) => m.state !== "not_applicable").map((m) => m.metric),
    },
    knowledge: res.knowledge,
    assignees: res.assignees,
  };
  return { ctx, knowledgeIds: res.knowledge.map((_, i) => res.knowledgeIds?.[i] ?? null) };
}

/** Resolves a draft's `usedKnowledge` indexes to the articles behind them. */
export function usedArticles(
  ctx: TicketContext,
  knowledgeIds: (string | null)[],
  draft: DraftReplyResult,
): UsedArticle[] {
  return [...new Set(draft.usedKnowledge)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < ctx.knowledge.length)
    .map((i) => ({ id: knowledgeIds[i] ?? null, title: ctx.knowledge[i]!.title, url: ctx.knowledge[i]!.url }));
}

/** Records a finished run (usage summed over its model calls) and meters it. Returns cap thresholds newly reached. */
async function finishRun<T>(
  tx: Tx,
  deps: WorkerDeps,
  orgId: string,
  run: { id: string; kind: "triage" | "draft_reply"; ticketId: string },
  result: AgentRunResult<T>,
): Promise<number[]> {
  const now = deps.clock.now();
  const u = result.metering.usage;
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costMicros") =>
    u.reduce((s, x) => s + x[k], 0);
  await tx
    .update(agentRuns)
    .set({
      status: result.ok ? "succeeded" : "failed",
      model: u[0]?.model ?? null,
      provider: u[0]?.provider ?? null,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      costMicros: sum("costMicros"),
      sandboxId: result.metering.sandbox?.id ?? null,
      sandboxSeconds: result.metering.sandbox?.seconds ?? null,
      output: result.ok ? (result.output as object) : null,
      error: result.ok ? null : `${result.error}: ${result.message}`.slice(0, 1000),
      finishedAt: now,
    })
    .where(eq(agentRuns.id, run.id));
  await meterRun(tx, orgId, now, result.metering, result.ok ? CREDITS[run.kind] : 0, {
    ticketId: run.ticketId,
    agentRunId: run.id,
  });
  return reachedCapThresholds(tx, orgId, now);
}

async function failRun(deps: WorkerDeps, orgId: string, runId: string, error: string) {
  await deps.orgDb.withOrg(orgId, (tx) =>
    tx.update(agentRuns).set({ status: "failed", error, finishedAt: deps.clock.now() }).where(eq(agentRuns.id, runId)),
  );
}

function internalNoteBody(triage: TriageResult | null, draft: DraftReplyResult, blockedReason: string | null) {
  const lines = ["slai draft for review"];
  if (triage) {
    lines.push(
      "",
      `Summary: ${triage.summary}`,
      `Category: ${triage.category} · Sentiment: ${triage.sentiment} · Suggested priority: ${triage.suggestedPriority}`,
    );
    if (triage.needsHuman) lines.push(`Needs a human: ${triage.needsHumanReason ?? "yes"}`);
  }
  if (blockedReason) lines.push(`Not sent automatically: ${blockedReason}`);
  if (draft.internalNote) lines.push("", `Note: ${draft.internalNote}`);
  lines.push("", "Proposed reply:", draft.body);
  return lines.join("\n");
}

/**
 * The `run-agent` job. A run with `requested_by` set is a manual trigger from
 * the API (no crossing check; at least assist). Otherwise it was dispatched by
 * a risk crossing. Autonomy and spend are re-checked here, at run time.
 */
export async function runAgent(deps: WorkerDeps, payload: { orgId: string; runId: string }): Promise<void> {
  const { orgId, runId } = payload;
  const now = deps.clock.now();
  const prep = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for("update");
    if (run?.status !== "queued" || !run.ticketId) return null;
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, run.ticketId));
    if (!ticket) return null;
    const rule = resolveAutonomy(await loadRules(tx), {
      customerAccountId: ticket.customerAccountId,
      priority: ticket.priority as Priority | null,
    });
    const billing = await currentBilling(tx, now);
    const decided = decideRunLevel({
      kind: run.kind === "triage" ? "triage" : "draft_reply",
      ruleLevel: rule.level,
      manual: run.requestedBy !== null,
      ceiling: billing.ceiling,
      spend: billing.spend,
    });
    if (decided.level === "observe") {
      await tx
        .update(agentRuns)
        .set({ status: "failed", error: decided.reason ?? "autonomy is observe", finishedAt: now })
        .where(eq(agentRuns.id, runId));
      return null;
    }
    // "triage" only reaches here for a triage run, which never drafts or sends.
    const level: Autonomy = decided.level === "triage" ? "assist" : decided.level;
    await tx.update(agentRuns).set({ status: "running", startedAt: now }).where(eq(agentRuns.id, runId));
    const { ctx, knowledgeIds } = await buildContextWithRefs(tx, deps, orgId, ticket);
    let triageRunId: string | null = null;
    if (run.kind === "draft_reply") {
      const [tr] = await tx
        .insert(agentRuns)
        .values({
          orgId,
          kind: "triage",
          status: "running",
          ticketId: ticket.id,
          requestedBy: run.requestedBy,
          createdAt: now,
          startedAt: now,
        })
        .returning({ id: agentRuns.id });
      triageRunId = tr!.id;
    }
    return { run, ticket, rule, level, ctx, knowledgeIds, triageRunId };
  });
  if (!prep) return;
  const { run, ticket, rule, level, ctx, knowledgeIds } = prep;
  if (run.kind !== "triage" && run.kind !== "draft_reply") {
    await failRun(deps, orgId, runId, `unsupported run kind ${run.kind}`);
    return;
  }

  try {
    // ---- triage ----
    const triageRunId = run.kind === "triage" ? run.id : prep.triageRunId!;
    const tri = await deps.agents.triage(ctx);
    const triage = tri.ok ? tri.output : null;
    const thresholds: number[] = [];
    await deps.orgDb.withOrg(orgId, async (tx) => {
      thresholds.push(
        ...(await finishRun(tx, deps, orgId, { id: triageRunId, kind: "triage", ticketId: ticket.id }, tri)),
      );
      if (triage) await proposeTriageActions(tx, orgId, ticket, triageRunId, triage, now);
    });
    if (run.kind === "triage") {
      await notifyCapThresholds(deps, orgId, thresholds);
      return;
    }

    // ---- draft ----
    const drafted = await deps.agents.draftReply(ctx, triage);
    // The run output records which articles the draft relied on (T-47).
    const used = drafted.ok ? usedArticles(ctx, knowledgeIds, drafted.output) : [];
    const dr = drafted.ok ? { ...drafted, output: { ...drafted.output, usedArticles: used } } : drafted;
    const conn = await deps.orgDb.withOrg(orgId, (tx) => loadConnection(tx, ticket.connectionId));
    const canNote = conn ? connectorFor(deps, conn).write.internalNote : false;
    const toSend: string[] = [];
    await deps.orgDb.withOrg(orgId, async (tx) => {
      thresholds.push(
        ...(await finishRun(tx, deps, orgId, { id: run.id, kind: "draft_reply", ticketId: ticket.id }, dr)),
      );
      if (!dr.ok) return;
      const draft = dr.output;
      const base: ActionInsert = {
        orgId,
        ticketId: ticket.id,
        agentRunId: run.id,
        kind: "public_reply",
        body: draft.body,
        confidence: draft.confidence,
        payload: {
          flags: draft.flags,
          usedKnowledge: draft.usedKnowledge,
          usedArticles: used,
          triage: triage ?? null,
          level,
        },
        createdAt: now,
      };
      let blockedReason: string | null = null;
      if (level === "autopilot") {
        const gate = decideAutopilot(draft, { minConfidence: rule.minConfidence, triage, ctx });
        if (gate.send) {
          const [a] = await tx
            .insert(agentActions)
            .values({ ...base, status: "approved", decidedAt: now })
            .returning({ id: agentActions.id });
          toSend.push(a!.id);
          await notifyEvent(tx, { orgId, type: "action.created", id: a!.id });
          return; // an auto-sent reply needs no review note
        }
        blockedReason = gate.reason;
      }
      const [reply] = await tx
        .insert(agentActions)
        .values({ ...base, status: "proposed", blockedReason })
        .returning({ id: agentActions.id });
      await notifyEvent(tx, { orgId, type: "action.created", id: reply!.id });
      if (canNote) {
        const [note] = await tx
          .insert(agentActions)
          .values({
            orgId,
            ticketId: ticket.id,
            agentRunId: run.id,
            kind: "internal_note",
            status: "approved",
            body: internalNoteBody(triage, draft, blockedReason),
            payload: { forActionId: reply!.id },
            decidedAt: now,
            createdAt: now,
          })
          .returning({ id: agentActions.id });
        toSend.push(note!.id);
        await notifyEvent(tx, { orgId, type: "action.created", id: note!.id });
      }
    });
    for (const id of toSend) {
      try {
        await performAction(deps, orgId, id);
      } catch (e) {
        // The run itself succeeded. The claim's reconcile job finishes (or safely retries) the write.
        deps.logger.warn({ orgId, actionId: id, err: errorMessage(e) }, "help-desk write deferred to reconcile");
      }
    }
    await notifyCapThresholds(deps, orgId, thresholds);
  } catch (e) {
    await failRun(deps, orgId, runId, errorMessage(e));
    if (prep.triageRunId) {
      await deps.orgDb.withOrg(orgId, (tx) =>
        tx
          .update(agentRuns)
          .set({ status: "failed", error: errorMessage(e), finishedAt: deps.clock.now() })
          .where(and(eq(agentRuns.id, prep.triageRunId!), eq(agentRuns.status, "running"))),
      );
    }
    throw e;
  }
}

/** Triage's suggested priority and owner become proposals for a human; never applied automatically. */
async function proposeTriageActions(
  tx: Tx,
  orgId: string,
  ticket: TicketRow,
  runId: string,
  triage: TriageResult,
  now: Date,
) {
  const rows: ActionInsert[] = [];
  if (triage.suggestedPriority !== ticket.priority) {
    rows.push({
      orgId,
      ticketId: ticket.id,
      agentRunId: runId,
      kind: "set_priority",
      status: "proposed",
      payload: { priority: triage.suggestedPriority, reason: triage.priorityReason, from: ticket.priority },
      confidence: triage.confidence,
      createdAt: now,
    });
  }
  if (triage.suggestedAssigneeSourceId && triage.suggestedAssigneeSourceId !== ticket.assigneeExternalId) {
    rows.push({
      orgId,
      ticketId: ticket.id,
      agentRunId: runId,
      kind: "assign",
      status: "proposed",
      payload: { assigneeSourceId: triage.suggestedAssigneeSourceId, from: ticket.assigneeExternalId },
      confidence: triage.confidence,
      createdAt: now,
    });
  }
  if (!rows.length) return;
  const created = await tx.insert(agentActions).values(rows).returning({ id: agentActions.id });
  for (const a of created) await notifyEvent(tx, { orgId, type: "action.created", id: a.id });
}

type ActionRow = typeof agentActions.$inferSelect;
type ConnectionRow = NonNullable<Awaited<ReturnType<typeof loadConnection>>>;

export interface Actor {
  type: "agent" | "user";
  id: string | null;
  name?: string | null;
}

/** A write is the approving user's; an action nobody approved was sent by the agent run that proposed it. */
function actorFor(action: ActionRow): Actor {
  return action.decidedBy
    ? { type: "user", id: action.decidedBy }
    : { type: "agent", id: action.agentRunId, name: "slai agent" };
}

/** Connector errors that mean the help desk refused the write (nothing landed). Anything else is ambiguous. */
const REFUSED = new Set<ConnectorError["kind"]>(["auth", "not_found", "invalid", "unsupported"]);

/** Only the holder of the current claim may resolve it. */
const holdsClaim = (a: ActionRow) =>
  and(
    eq(agentActions.id, a.id),
    eq(agentActions.status, "sending"),
    a.sendAttemptId ? eq(agentActions.sendAttemptId, a.sendAttemptId) : isNull(agentActions.sendAttemptId),
  );

/**
 * Claims the action for one write (approved → sending, or a new attempt on a
 * lost one) and, in the same transaction, schedules the reconcile job that
 * finishes the write if this worker dies before recording it.
 */
async function claimSend(tx: Tx, deps: WorkerDeps, orgId: string, a: ActionRow, now: Date): Promise<ActionRow | null> {
  const [claimed] = await tx
    .update(agentActions)
    .set({
      status: "sending",
      sendingAt: now,
      sendAttemptId: randomUUID(),
      sendAttempts: sql`${agentActions.sendAttempts} + 1`,
      error: null,
    })
    .where(
      a.status === "approved" ? and(eq(agentActions.id, a.id), eq(agentActions.status, "approved")) : holdsClaim(a),
    )
    .returning();
  if (!claimed) return null;
  await deps.queue.send(
    "execute-action",
    { orgId, actionId: a.id },
    { tx, startAfter: new Date(now.getTime() + deps.config.sendReconcileMs) },
  );
  return claimed;
}

/**
 * Performs an approved action against the help desk exactly once, then records
 * the result and an audit event (every help-desk write is audited). Afterwards
 * the ticket is re-ingested so slai sees its own reply stop the clock.
 *
 * The write and its record are not atomic, so the action is claimed first
 * (approved → sending, TR-21g). A retry that finds a fresh claim leaves it to
 * the claim's reconcile job; one that finds a stale claim looks for the write
 * on the help desk before writing again.
 */
export async function performAction(deps: WorkerDeps, orgId: string, actionId: string): Promise<void> {
  const now = deps.clock.now();
  const loaded = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [action] = await tx.select().from(agentActions).where(eq(agentActions.id, actionId)).for("update");
    if (!action) return null;
    const step = decideSendStep(action, now, deps.config.sendReconcileMs);
    if (step === "done") return null;
    if (step === "wait") {
      deps.logger.info({ orgId, actionId, sendingAt: action.sendingAt }, "write in flight; left to reconcile");
      return null;
    }
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, action.ticketId));
    const conn = ticket ? await loadConnection(tx, ticket.connectionId) : null;
    if (!ticket || !conn) return null;
    if (step === "reconcile") return { step, action, ticket, conn };
    const claimed = await claimSend(tx, deps, orgId, action, now);
    return claimed ? { step, action: claimed, ticket, conn } : null;
  });
  if (!loaded) return;
  const { ticket, conn } = loaded;
  let action = loaded.action;
  const client = clientFor(deps, conn);

  if (loaded.step === "reconcile") {
    // A claim outlived its worker. Did the write land before the crash?
    let history: Awaited<ReturnType<typeof client.getTicketWithHistory>>;
    try {
      history = await client.getTicketWithHistory(ticket.externalId);
    } catch (e) {
      // The ticket is gone from the help desk: nothing can land there any more.
      if (!(e instanceof ConnectorError && e.kind === "not_found")) throw e;
      const error = errorMessage(e);
      await recordWrite(deps, orgId, action, ticket, conn, { externalRef: null, error, reconciled: true });
      return;
    }
    const knownRefs = await deps.orgDb.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ ref: agentActions.externalRef })
        .from(agentActions)
        .where(
          and(
            eq(agentActions.ticketId, ticket.id),
            ne(agentActions.id, action.id),
            isNotNull(agentActions.externalRef),
          ),
        );
      return rows.map((r) => r.ref!);
    });
    const found = findSentComment(action, history.comments, { knownRefs });
    if (found) {
      await recordWrite(deps, orgId, action, ticket, conn, { externalRef: found, error: null, reconciled: true });
      return;
    }
    // Not there after the safe interval: take the claim over and write again.
    const retaken = await deps.orgDb.withOrg(orgId, (tx) => claimSend(tx, deps, orgId, action, deps.clock.now()));
    if (!retaken) return;
    action = retaken;
  }

  const payload = (action.payload ?? {}) as Record<string, unknown>;
  let externalRef: string | null = null;
  let error: string | null = null;
  try {
    switch (action.kind) {
      case "public_reply":
        externalRef = (await client.postPublicReply(ticket.externalId, action.body ?? "")).commentSourceId;
        break;
      case "internal_note":
        externalRef = (await client.postInternalNote(ticket.externalId, action.body ?? "")).commentSourceId;
        break;
      case "set_priority":
        await client.updateTicket(ticket.externalId, { priority: payload.priority as Priority });
        break;
      case "assign":
        await client.updateTicket(ticket.externalId, { assigneeSourceId: String(payload.assigneeSourceId) });
        break;
    }
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === "rate_limited") {
      // Nothing was written: release the claim, and the job retries after Retry-After.
      const held = action;
      await deps.orgDb.withOrg(orgId, (tx) =>
        tx.update(agentActions).set({ status: "approved", sendingAt: null }).where(holdsClaim(held)),
      );
      throw e;
    }
    // Anything but a clear refusal may have landed (a timeout, a 5xx, a crash): keep the claim; reconcile decides.
    if (!(e instanceof ConnectorError && REFUSED.has(e.kind))) throw e;
    if (e.kind === "auth") await markConnectionError(deps, orgId, conn.id, e);
    error = errorMessage(e);
  }
  await recordWrite(deps, orgId, action, ticket, conn, { externalRef, error, reconciled: false });
}

/** Resolves the claim (sending → sent/failed), audits the write, meters autopilot, and re-ingests the ticket. */
async function recordWrite(
  deps: WorkerDeps,
  orgId: string,
  action: ActionRow,
  ticket: TicketRow,
  conn: ConnectionRow,
  result: { externalRef: string | null; error: string | null; reconciled: boolean },
): Promise<void> {
  const { externalRef, error } = result;
  const actor = actorFor(action);
  const now = deps.clock.now();
  const thresholds = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [resolved] = await tx
      .update(agentActions)
      .set(error ? { status: "failed", error } : { status: "sent", externalRef, error: null })
      .where(holdsClaim(action))
      .returning({ id: agentActions.id });
    if (!resolved) return []; // another worker resolved this claim
    await audit(tx, {
      orgId,
      actor: { type: actor.type, id: actor.id, name: actor.name ?? null },
      action: error ? "action.failed" : "action.sent",
      target: { type: "agent_action", id: action.id },
      metadata: {
        kind: action.kind,
        ticketId: ticket.id,
        connectionId: conn.id,
        provider: conn.provider,
        externalRef,
        attempt: action.sendAttempts,
        ...(result.reconciled && { reconciled: true }),
        ...(error && { error }),
      },
    });
    const autopilot = actor.type === "agent" && action.kind === "public_reply";
    let reached: number[] = [];
    if (!error && autopilot) {
      await meterAction(tx, orgId, now, "autopilot_reply", { ticketId: ticket.id, agentRunId: action.agentRunId });
      reached = await reachedCapThresholds(tx, orgId, now);
    }
    await notifyEvent(tx, { orgId, type: "action.created", id: action.id });
    await notifyEvent(tx, { orgId, type: "ticket.updated", id: ticket.id });
    if (!error) {
      await deps.queue.send(
        "ingest-ticket",
        { orgId, connectionId: conn.id, ticketSourceId: ticket.externalId },
        { tx },
      );
    }
    return reached;
  });
  await notifyCapThresholds(deps, orgId, thresholds);
}

/**
 * The `execute-action` job: a human approved the action in the API, or a
 * claim's reconcile job came due. Both are safe to run any number of times.
 */
export async function executeAction(deps: WorkerDeps, payload: { orgId: string; actionId: string }): Promise<void> {
  await performAction(deps, payload.orgId, payload.actionId);
}
