import {
  agentActions,
  agentRuns,
  audit,
  connections,
  customerAccounts,
  fromStoredEvaluation,
  notifyEvent,
  type StoredEvaluation,
  slaOutcomes,
  slaPolicies,
  type Tx,
  ticketComments,
  ticketEvents,
  tickets,
  toEngineEvents,
  toStoredEvaluation,
  usageLedger,
} from "@slai/db";
import { RISK, type TicketDetail } from "@slai/shared";
import { evaluateTicket, parsePolicy } from "@slai/sla-engine";
import { and, asc, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { notFound } from "../errors.js";
import { toAgentAction, toAgentRun, toMetricView, toTicketSummary } from "../mappers.js";
import { decodeCursor, page, pageQuery } from "../pagination.js";
import { nameOf, userNames } from "../people.js";
import { idParam, query } from "../validate.js";

const listQuery = pageQuery.extend({
  risk: z.enum(RISK).optional(),
  status: z.enum(["new", "open", "pending", "on_hold", "solved", "closed"]).optional(),
  customerId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
const ticketCursor = z.object({ due: z.string().nullable(), id: z.uuid() });

/** Sort key: soonest due first, tickets with nothing due last. */
const dueKey = sql`coalesce(${tickets.nextDueAt}, 'infinity'::timestamptz)`;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function selectSummaries(tx: Tx) {
  return tx
    .select({
      t: tickets,
      provider: connections.provider,
      customerName: customerAccounts.name,
      policyName: slaPolicies.name,
    })
    .from(tickets)
    .innerJoin(connections, eq(connections.id, tickets.connectionId))
    .leftJoin(customerAccounts, eq(customerAccounts.id, tickets.customerAccountId))
    .leftJoin(slaPolicies, eq(slaPolicies.id, tickets.policyId));
}

/** An enum value as words: "on_hold" → "on hold". */
const words = (v: unknown) => String(v).replace(/_/g, " ");
const METRIC_WORDS: Record<string, string> = {
  first_response: "First response",
  next_response: "Next response",
  periodic_update: "Periodic update",
  resolution: "Resolution",
};

const EVENT_LABEL: Record<string, (p: Record<string, unknown>) => string> = {
  created: (p) => `Ticket created${p.priority ? ` (${words(p.priority)} priority)` : ""}`,
  priority_changed: (p) => `Priority changed to ${p.priority ? words(p.priority) : "none"}`,
  status_changed: (p) => `Status changed to ${words(p.status)}`,
  assignee_changed: () => "Assignee changed",
  tags_changed: () => "Tags updated",
};

export function ticketRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const q = query(c, listQuery);
    const cur = decodeCursor(q.cursor, ticketCursor);
    const conds: (SQL | undefined)[] = [
      q.risk ? eq(tickets.risk, q.risk) : undefined,
      q.status ? eq(tickets.status, q.status) : undefined,
      q.customerId ? eq(tickets.customerAccountId, q.customerId) : undefined,
    ];
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      conds.push(
        or(ilike(tickets.subject, like), ilike(tickets.displayKey, like), ilike(tickets.requesterEmail, like)),
      );
    }
    if (cur) {
      const due = cur.due ?? "infinity";
      conds.push(sql`(${dueKey}, ${tickets.id}) > (${due}::timestamptz, ${cur.id}::uuid)`);
    }
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      selectSummaries(tx)
        .where(and(...conds))
        .orderBy(asc(dueKey), asc(tickets.id))
        .limit(q.limit + 1),
    );
    return c.json(
      page(rows, q.limit, toTicketSummary, (r) => ({ due: r.t.nextDueAt?.toISOString() ?? null, id: r.t.id })),
    );
  });

  app.get("/:id", async (c) => {
    const id = idParam(c, "id", "Ticket");
    const now = deps.now();
    const detail = await deps.orgDb.withOrg(auth(c).orgId, async (tx): Promise<TicketDetail> => {
      const [row] = await selectSummaries(tx).where(eq(tickets.id, id));
      if (!row) throw notFound("Ticket");
      const [events, comments, runs, actions, breaches, policy] = await Promise.all([
        tx
          .select()
          .from(ticketEvents)
          .where(eq(ticketEvents.ticketId, id))
          .orderBy(asc(ticketEvents.at), asc(ticketEvents.id)),
        tx.select().from(ticketComments).where(eq(ticketComments.ticketId, id)),
        tx.select().from(agentRuns).where(eq(agentRuns.ticketId, id)).orderBy(desc(agentRuns.id)),
        tx.select().from(agentActions).where(eq(agentActions.ticketId, id)).orderBy(desc(agentActions.id)),
        tx
          .select()
          .from(slaOutcomes)
          .where(and(eq(slaOutcomes.ticketId, id), eq(slaOutcomes.state, "breached"))),
        row.t.policyId
          ? tx
              .select({ definition: slaPolicies.definition })
              .from(slaPolicies)
              .where(eq(slaPolicies.id, row.t.policyId))
          : Promise.resolve([]),
      ]);

      // Metrics are recomputed by the engine at `now` when possible (fresh remaining time);
      // otherwise the worker's last stored evaluation is shown.
      let evaluation = row.t.evaluation as StoredEvaluation | null;
      if (policy[0] && events.length > 0) {
        try {
          evaluation = toStoredEvaluation(
            evaluateTicket(parsePolicy(policy[0].definition), toEngineEvents(events), now),
          );
        } catch {
          // Fall back to the stored evaluation.
        }
      }
      const commentsById = new Map(comments.map((cm) => [cm.sourceId, cm]));
      const timeline: TicketDetail["timeline"] = events.map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        if (e.type === "comment") {
          const cm = commentsById.get(String(p.commentSourceId ?? ""));
          const pub = p.public === true;
          const label = p.author === "requester" ? "Customer replied" : pub ? "Public reply" : "Internal note";
          return {
            at: e.at.toISOString(),
            type: e.type,
            label,
            public: pub,
            ...(cm?.authorName ? { author: cm.authorName } : {}),
          };
        }
        return { at: e.at.toISOString(), type: e.type, label: (EVENT_LABEL[e.type] ?? (() => words(e.type)))(p) };
      });
      for (const b of breaches) {
        if (b.breachAt)
          timeline.push({
            at: b.breachAt.toISOString(),
            type: "sla_breached",
            label: `${METRIC_WORDS[b.metric] ?? words(b.metric)} SLA breached`,
          });
      }
      timeline.sort((x, y) => x.at.localeCompare(y.at));

      const summary = toTicketSummary(row);
      if (evaluation && evaluation !== row.t.evaluation) {
        const ev = fromStoredEvaluation(evaluation);
        const u = evaluation.mostUrgent;
        Object.assign(summary, {
          risk: ev.risk,
          next: u ? { metric: u.metric, dueAt: u.dueAt, remainingMs: u.remainingMs, state: u.state } : null,
        });
      }
      const names = await userNames(
        tx,
        actions.map((x) => x.decidedBy),
      );
      const runCredits = new Map<string, number>();
      if (runs.length) {
        const spent = await tx
          .select({
            runId: usageLedger.agentRunId,
            credits: sql<number>`coalesce(sum(${usageLedger.credits}), 0)::int`,
          })
          .from(usageLedger)
          .where(
            inArray(
              usageLedger.agentRunId,
              runs.map((r) => r.id),
            ),
          )
          .groupBy(usageLedger.agentRunId);
        for (const s of spent) if (s.runId) runCredits.set(s.runId, s.credits);
      }
      return {
        ...summary,
        requester: { name: row.t.requesterName, email: row.t.requesterEmail },
        metrics: (evaluation?.metrics ?? []).map(toMetricView),
        timeline,
        agentRuns: runs.map((r) => toAgentRun(r, runCredits.get(r.id) ?? 0)),
        actions: actions.map((x) => toAgentAction(x, row.t, nameOf(names, x.decidedBy))),
      };
    });
    return c.json(detail);
  });

  app.post("/:id/agents/:kind", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Ticket");
    const kind = z.enum(["triage", "draft_reply"]).safeParse(c.req.param("kind"));
    if (!kind.success) throw notFound("Agent");
    const run = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [t] = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
      if (!t) throw notFound("Ticket");
      const [r] = await tx
        .insert(agentRuns)
        .values({ orgId: a.orgId, kind: kind.data, status: "queued", ticketId: id, requestedBy: a.user.id })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "agent.requested",
        target: { type: "agent_run", id: r!.id },
        metadata: { kind: kind.data, ticketId: id },
      });
      await deps.jobs.send(tx, "run-agent", { orgId: a.orgId, runId: r!.id });
      await notifyEvent(tx, { orgId: a.orgId, type: "ticket.updated", id });
      return r!;
    });
    return c.json(toAgentRun(run), 202);
  });

  return app;
}
