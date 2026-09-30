/**
 * Agent runs and help-desk writes (T-43). Agents only propose; this module
 * decides what happens to each proposal and performs (and audits) every write
 * to the help desk.
 */
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
import { and, desc, eq } from "drizzle-orm";
import { clientFor, connectorFor, loadConnection, markConnectionError } from "./connection.js";
import { type Autonomy, resolveAutonomy } from "./decide.js";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";
import { CREDITS, currentSpend, meterAction, meterRun, reachedCapThresholds } from "./metering.js";
import { loadRules } from "./react.js";
import { notifyCapThresholds } from "./spend.js";

type TicketRow = typeof tickets.$inferSelect;
type ActionInsert = typeof agentActions.$inferInsert;

export const THREAD_LIMIT = 20;
export const MESSAGE_CHARS = 4000;

/** Bounded, oldest-first thread plus the SLA state the engine computed. */
export async function buildContext(tx: Tx, deps: WorkerDeps, orgId: string, t: TicketRow): Promise<TicketContext> {
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
  const res = await deps.resources(orgId, { id: t.id, connectionId: t.connectionId, subject: t.subject });
  return {
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
    const manual = run.requestedBy !== null;
    let level: Autonomy = manual && rule.level === "observe" ? "assist" : rule.level;
    let reason = "";
    if ((await currentSpend(tx, now)) === "over_cap") {
      level = "observe";
      reason = "spend cap reached: observe only";
    } else if (level === "observe") reason = "autonomy is observe";
    if (level === "observe") {
      await tx
        .update(agentRuns)
        .set({ status: "failed", error: reason, finishedAt: now })
        .where(eq(agentRuns.id, runId));
      return null;
    }
    await tx.update(agentRuns).set({ status: "running", startedAt: now }).where(eq(agentRuns.id, runId));
    const ctx = await buildContext(tx, deps, orgId, ticket);
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
    return { run, ticket, rule, level, ctx, triageRunId };
  });
  if (!prep) return;
  const { run, ticket, rule, level, ctx } = prep;
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
    const dr = await deps.agents.draftReply(ctx, triage);
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
        payload: { flags: draft.flags, usedKnowledge: draft.usedKnowledge, triage: triage ?? null, level },
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
      await performAction(deps, orgId, id, { type: "agent", id: run.id, name: "slai agent" });
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

export interface Actor {
  type: "agent" | "user";
  id: string | null;
  name?: string | null;
}

/**
 * Performs an approved action against the help desk, then records the result
 * and an audit event (every help-desk write is audited). Afterwards the ticket
 * is re-ingested so slai sees its own reply stop the clock.
 */
export async function performAction(deps: WorkerDeps, orgId: string, actionId: string, actor: Actor): Promise<void> {
  const loaded = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [action] = await tx.select().from(agentActions).where(eq(agentActions.id, actionId));
    if (action?.status !== "approved") return null;
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, action.ticketId));
    const conn = ticket ? await loadConnection(tx, ticket.connectionId) : null;
    return action && ticket && conn ? { action, ticket, conn } : null;
  });
  if (!loaded) return;
  const { action, ticket, conn } = loaded;
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  let externalRef: string | null = null;
  let error: string | null = null;
  try {
    const client = clientFor(deps, conn);
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
    // Rate limits retry the whole job; the action stays approved.
    if (e instanceof ConnectorError && e.kind === "rate_limited") throw e;
    if (e instanceof ConnectorError && e.kind === "auth") await markConnectionError(deps, orgId, conn.id, e);
    error = errorMessage(e);
  }

  const now = deps.clock.now();
  const thresholds = await deps.orgDb.withOrg(orgId, async (tx) => {
    await tx
      .update(agentActions)
      .set(error ? { status: "failed", error } : { status: "sent", externalRef, error: null })
      .where(eq(agentActions.id, actionId));
    await audit(tx, {
      orgId,
      actor: { type: actor.type, id: actor.id, name: actor.name ?? null },
      action: error ? "action.failed" : "action.sent",
      target: { type: "agent_action", id: actionId },
      metadata: {
        kind: action.kind,
        ticketId: ticket.id,
        connectionId: conn.id,
        provider: conn.provider,
        externalRef,
        ...(error && { error }),
      },
    });
    const autopilot = actor.type === "agent" && action.kind === "public_reply";
    let reached: number[] = [];
    if (!error && autopilot) {
      await meterAction(tx, orgId, now, "autopilot_reply", { ticketId: ticket.id, agentRunId: action.agentRunId });
      reached = await reachedCapThresholds(tx, orgId, now);
    }
    await notifyEvent(tx, { orgId, type: "action.created", id: actionId });
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

/** The `execute-action` job: a human approved the action in the API. */
export async function executeAction(deps: WorkerDeps, payload: { orgId: string; actionId: string }): Promise<void> {
  const decided = await deps.orgDb.withOrg(payload.orgId, async (tx) => {
    const [a] = await tx
      .select({ decidedBy: agentActions.decidedBy })
      .from(agentActions)
      .where(eq(agentActions.id, payload.actionId));
    return a ?? null;
  });
  if (!decided) return;
  await performAction(deps, payload.orgId, payload.actionId, { type: "user", id: decided.decidedBy });
}
