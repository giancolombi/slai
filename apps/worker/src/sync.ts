/**
 * Keeping tickets current (T-41): the reconciliation poll, webhooks, and the
 * per-ticket ingest and re-evaluation jobs.
 */
import { ConnectorError, type MappingIssue } from "@slai/connectors";
import { connections } from "@slai/db";
import { eq } from "drizzle-orm";
import { clientFor, guardAuth, loadConnection, mergeIssues, recordMappingIssues } from "./connection.js";
import type { WorkerDeps } from "./deps.js";
import { evaluateStored, knownUpdates, persistTicket } from "./ingest.js";
import { performReaction, planReaction } from "./react.js";

const DAY_MS = 86_400_000;
const MAX_PAGES = 1000;

/**
 * Pages through tickets updated since the connection's cursor (minus a small
 * overlap) and enqueues an ingest for each one that changed.
 */
export async function syncConnection(
  deps: WorkerDeps,
  p: { orgId: string; connectionId: string; full: boolean },
): Promise<void> {
  const { orgId, connectionId } = p;
  const conn = await deps.orgDb.withOrg(orgId, (tx) => loadConnection(tx, connectionId));
  if (!conn || conn.status === "paused") return;
  const now = deps.clock.now();
  const cursorAt = conn.syncCursor ? new Date(conn.syncCursor) : null;
  const since =
    p.full || !cursorAt || Number.isNaN(cursorAt.getTime())
      ? new Date(now.getTime() - deps.config.backfillDays * DAY_MS)
      : new Date(cursorAt.getTime() - deps.config.syncOverlapMs);

  await guardAuth(deps, orgId, connectionId, async () => {
    const client = clientFor(deps, conn);
    let cursor: string | null = null;
    let highWater = cursorAt && !p.full ? cursorAt : since;
    let issues: MappingIssue[] = [];
    let enqueued = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.listUpdatedTickets(since, cursor);
      const known = await deps.orgDb.withOrg(orgId, (tx) =>
        knownUpdates(
          tx,
          connectionId,
          res.items.map((t) => t.ref.sourceId),
        ),
      );
      for (const t of res.items) {
        if (t.updatedAt > highWater) highWater = t.updatedAt;
        if (t.mappingIssues?.length) issues = mergeIssues(issues, t.mappingIssues);
        const seen = known.get(t.ref.sourceId);
        if (seen && seen.getTime() >= t.updatedAt.getTime()) continue;
        await deps.queue.send("ingest-ticket", { orgId, connectionId, ticketSourceId: t.ref.sourceId });
        enqueued++;
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    await deps.orgDb.withOrg(orgId, async (tx) => {
      await tx
        .update(connections)
        .set({ syncCursor: highWater.toISOString(), lastSyncAt: now, lastError: null, status: "active" })
        .where(eq(connections.id, connectionId));
      await recordMappingIssues(tx, connectionId, issues);
    });
    deps.logger.info({ orgId, connectionId, enqueued, full: p.full }, "sync done");
  });
}

/** Webhooks only tell us which tickets changed; each is then ingested from its history. */
export async function processWebhook(
  deps: WorkerDeps,
  p: { orgId: string; connectionId: string; ticketSourceIds: string[] },
): Promise<void> {
  for (const id of new Set(p.ticketSourceIds)) {
    await deps.queue.send("ingest-ticket", { orgId: p.orgId, connectionId: p.connectionId, ticketSourceId: id });
  }
}

/** Fetches one ticket's full history, ingests and evaluates it, and reacts to a risk crossing. */
export async function ingestTicket(
  deps: WorkerDeps,
  p: { orgId: string; connectionId: string; ticketSourceId: string },
): Promise<void> {
  const { orgId, connectionId } = p;
  const conn = await deps.orgDb.withOrg(orgId, (tx) => loadConnection(tx, connectionId));
  if (!conn || conn.status === "paused") return;
  await guardAuth(deps, orgId, connectionId, async () => {
    let history: Awaited<ReturnType<ReturnType<typeof clientFor>["getTicketWithHistory"]>>;
    try {
      history = await clientFor(deps, conn).getTicketWithHistory(p.ticketSourceId);
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === "not_found") {
        deps.logger.info({ orgId, connectionId, ticketSourceId: p.ticketSourceId }, "ticket not found; skipped");
        return;
      }
      throw e;
    }
    const reaction = await deps.orgDb.withOrg(orgId, async (tx) => {
      const ticketId = await persistTicket(tx, orgId, connectionId, history);
      await recordMappingIssues(tx, connectionId, history.ticket.mappingIssues);
      const ev = await evaluateStored(tx, orgId, ticketId, deps.clock.now());
      return ev ? planReaction(tx, deps, orgId, ev) : null;
    });
    await performReaction(deps, reaction);
  });
}

/** The timer path: re-evaluate from stored events (no help-desk call). */
export async function evaluateTicketJob(deps: WorkerDeps, p: { orgId: string; ticketId: string }): Promise<void> {
  const reaction = await deps.orgDb.withOrg(p.orgId, async (tx) => {
    const ev = await evaluateStored(tx, p.orgId, p.ticketId, deps.clock.now());
    return ev ? planReaction(tx, deps, p.orgId, ev) : null;
  });
  await performReaction(deps, reaction);
}
