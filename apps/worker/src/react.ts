/**
 * Reacting to a ticket's risk transition (T-42, and the dispatch half of T-43).
 *
 * `planReaction` runs inside the evaluation transaction (the ticket row is
 * locked, so previous-vs-new risk is exact): it picks the channels to notify
 * and, if an agent should run, creates the queued run and enqueues it with the
 * commit. `performReaction` sends the notifications after commit.
 */
import { agentActions, agentRuns, autonomyRules, type Tx, ticketComments } from "@slai/db";
import type { Priority, RiskLevel } from "@slai/sla-engine";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { type AutonomyRuleLike, actionableRisk, channelsToNotify, decideDispatch, resolveAutonomy } from "./decide.js";
import type { WorkerDeps } from "./deps.js";
import type { Evaluated } from "./ingest.js";
import { currentBilling } from "./metering.js";
import { type Channel, enabledChannels, sendNotifications } from "./notify.js";

export interface Reaction {
  orgId: string;
  ticketId: string;
  displayKey: string;
  subject: string;
  prevRisk: RiskLevel | null;
  risk: RiskLevel;
  channels: Channel[];
  dispatch: string;
}

export async function loadRules(tx: Tx): Promise<AutonomyRuleLike[]> {
  const rows = await tx.select().from(autonomyRules);
  return rows.map((r) => ({
    id: r.id,
    customerAccountId: r.customerAccountId,
    priority: r.priority,
    level: r.level,
    triggerAt: r.triggerAt,
    minConfidence: r.minConfidence,
  }));
}

/**
 * True when an agent already acted on this ticket since the customer last
 * wrote: a live draft run, or a reply action created after the latest public
 * requester comment.
 */
export async function alreadyHandled(tx: Tx, ticketId: string): Promise<boolean> {
  const [live] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.ticketId, ticketId),
        eq(agentRuns.kind, "draft_reply"),
        inArray(agentRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (live) return true;
  const [last] = await tx
    .select({ at: ticketComments.at })
    .from(ticketComments)
    .where(
      and(
        eq(ticketComments.ticketId, ticketId),
        eq(ticketComments.authorRole, "requester"),
        eq(ticketComments.public, true),
      ),
    )
    .orderBy(desc(ticketComments.at))
    .limit(1);
  const [action] = await tx
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.ticketId, ticketId),
        eq(agentActions.kind, "public_reply"),
        inArray(agentActions.status, ["proposed", "approved", "sending", "sent", "blocked"]),
        last ? gt(agentActions.createdAt, last.at) : undefined,
      ),
    )
    .limit(1);
  return action !== undefined;
}

export async function planReaction(tx: Tx, deps: WorkerDeps, orgId: string, ev: Evaluated): Promise<Reaction | null> {
  if (ev.prevRisk === ev.risk) return null;
  const now = deps.clock.now();
  const t = ev.ticket;
  // First evaluation (connect, backfill): only a still-actionable risk may trigger (TR-21f).
  const actionable = ev.evaluation ? actionableRisk(ev.evaluation.metrics, now, deps.config.firstSeenGraceMs) : ev.risk;

  // Alerts are never throttled by spend; they fire for open tickets, once per crossing of each channel's minimum.
  const channels = ev.open
    ? channelsToNotify(await enabledChannels(tx), ev.prevRisk, ev.risk, actionable).map((c) => ({
        id: c.id,
        kind: c.kind,
        target: c.target,
      }))
    : [];

  const rule = resolveAutonomy(await loadRules(tx), {
    customerAccountId: t.customerAccountId,
    priority: t.priority as Priority | null,
  });
  // The plan's ceiling and the spend cap limit agents only; alerts above are never throttled (T-65).
  const billing = await currentBilling(tx, now);
  const decision = decideDispatch({
    prevRisk: ev.prevRisk,
    nextRisk: ev.risk,
    actionableRisk: actionable,
    ticketOpen: ev.open,
    rule,
    ceiling: billing.ceiling,
    spend: billing.spend,
    alreadyHandled: await alreadyHandled(tx, t.id),
  });
  if (decision.runTriage) {
    // A triage-only plan (Starter) queues a triage run; otherwise the draft run triages first.
    const kind = decision.runDraft ? "draft_reply" : "triage";
    const [run] = await tx
      .insert(agentRuns)
      .values({ orgId, kind, status: "queued", ticketId: t.id, createdAt: now })
      .returning({ id: agentRuns.id });
    await deps.queue.send("run-agent", { orgId, runId: run!.id }, { tx });
  }
  deps.logger.info(
    { orgId, ticketId: t.id, from: ev.prevRisk, to: ev.risk, channels: channels.length, dispatch: decision.reason },
    "risk transition",
  );
  return {
    orgId,
    ticketId: t.id,
    displayKey: t.displayKey,
    subject: t.subject,
    prevRisk: ev.prevRisk,
    risk: ev.risk,
    channels,
    dispatch: decision.reason,
  };
}

const LABEL: Record<RiskLevel, string> = { ok: "OK", warning: "Warning", at_risk: "At risk", breached: "Breached" };

export async function performReaction(deps: WorkerDeps, r: Reaction | null): Promise<void> {
  if (!r?.channels.length) return;
  const link = `${deps.config.appUrl}/tickets/${r.ticketId}`;
  await sendNotifications(
    deps,
    r.orgId,
    r.channels,
    {
      subject: `[slai] ${r.displayKey} is ${LABEL[r.risk].toLowerCase()}`,
      text: `Ticket ${r.displayKey} "${r.subject}" moved from ${r.prevRisk ? LABEL[r.prevRisk] : "new"} to ${LABEL[r.risk]}.\n\n${link}`,
    },
    { target: { type: "ticket", id: r.ticketId }, metadata: { from: r.prevRisk, to: r.risk } },
  );
}
