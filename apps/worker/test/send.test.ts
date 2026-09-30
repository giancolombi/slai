/**
 * T-49: a help-desk write and its record are not atomic. Claiming the action
 * (approved → sending) before the write, and reconciling a stale claim against
 * the ticket's history, keeps every reply to exactly one send.
 */
import { randomUUID } from "node:crypto";
import { type ConnectorDefinition, ConnectorError, getConnector } from "@slai/connectors";
import { agentActions, auditEvents, tickets, users } from "@slai/db";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { executeAction } from "../src/agents.js";
import { createConnection, createOrg, createPolicy, parkTimers, setupWorker } from "./harness.js";

type Mode = "ok" | "crash-before" | "crash-after" | "rate-limited" | "slow";

// The demo help desk, with a fault injected into the next public reply.
const demo = getConnector("demo")!;
const fault: { next: Mode; writes: number } = { next: "ok", writes: 0 };
const faulty: ConnectorDefinition<Record<string, never>> = {
  ...demo,
  create: (ctx) => {
    const inner = demo.create(ctx);
    return {
      ...inner,
      async postPublicReply(sourceId, body) {
        const mode = fault.next;
        fault.next = "ok";
        if (mode === "crash-before") throw new Error("worker crashed before the write");
        if (mode === "rate-limited") throw new ConnectorError("slow down", "rate_limited", 30_000);
        if (mode === "slow") await new Promise((r) => setTimeout(r, 100));
        const res = await inner.postPublicReply(sourceId, body);
        fault.writes++;
        if (mode === "crash-after") throw new Error("worker crashed after the write");
        return res;
      },
    };
  },
};

const h = setupWorker({ connectors: { get: (p) => (p === "demo" ? faulty : getConnector(p)) } });
const { owner } = h;
let orgId: string;
let connectionId: string;
let ticket: typeof tickets.$inferSelect;
let userId: string;

/** What the help desk actually holds: public comments with this exact body. */
async function onHelpDesk(body: string) {
  const client = demo.create({
    credentials: {},
    config: { seed: "send", ticketsPerDay: 5, historyDays: 2, connectionId, now: () => h.clock.now() },
    mapping: demo.defaultMapping,
    fetch,
  });
  const history = await client.getTicketWithHistory(ticket.externalId);
  return history.comments.filter((c) => c.public && c.bodyText === body).length;
}

async function approvedReply(body: string) {
  const [a] = await owner.db
    .insert(agentActions)
    .values({
      orgId,
      ticketId: ticket.id,
      kind: "public_reply",
      status: "approved",
      body,
      decidedBy: userId,
      decidedAt: h.clock.now(),
    })
    .returning();
  return a!.id;
}

const actionRow = async (id: string) => (await owner.db.select().from(agentActions).where(eq(agentActions.id, id)))[0]!;
const writesAudited = (id: string) =>
  owner.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.targetId, id), inArray(auditEvents.action, ["action.sent", "action.failed"])));
const pastReconcile = async () => {
  h.clock.advance(h.deps.config.sendReconcileMs);
  await h.drain();
};

beforeAll(async () => {
  orgId = await createOrg(owner);
  await createPolicy(owner, orgId);
  connectionId = await createConnection(h, orgId, { config: { seed: "send", ticketsPerDay: 5, historyDays: 2 } });
  await h.queue.send("sync-connection", { orgId, connectionId, full: true });
  await h.drain();
  await parkTimers(owner, orgId);
  const rows = await owner.db.select().from(tickets).where(eq(tickets.orgId, orgId));
  ticket = rows.find((t) => t.status === "open" || t.status === "new") ?? rows[0]!;
  userId = randomUUID();
  await owner.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.com`, name: "Approver", passwordHash: "x" });
});

describe("idempotent help-desk writes", () => {
  it("a retry after a crash just after the write does not send twice", async () => {
    const body = `Crash after the write ${randomUUID()}`;
    const id = await approvedReply(body);
    fault.writes = 0;
    fault.next = "crash-after";
    await expect(executeAction(h.deps, { orgId, actionId: id })).rejects.toThrow(/after the write/);
    expect(await onHelpDesk(body)).toBe(1);
    expect((await actionRow(id)).status).toBe("sending");

    // pg-boss retries at once: the claim is fresh, so the retry leaves it alone.
    await executeAction(h.deps, { orgId, actionId: id });
    expect(fault.writes).toBe(1);

    // The claim's reconcile job finds the reply in the ticket history and records it.
    await pastReconcile();
    const a = await actionRow(id);
    expect(a.status).toBe("sent");
    expect(a.externalRef).toMatch(/-w\d+$/);
    expect(fault.writes).toBe(1);
    expect(await onHelpDesk(body)).toBe(1);
    const audits = await writesAudited(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ reconciled: true, externalRef: a.externalRef });
    expect(audits[0]!.actorId).toBe(userId);
  });

  it("a retry after a crash before the write sends exactly once", async () => {
    const body = `Crash before the write ${randomUUID()}`;
    const id = await approvedReply(body);
    fault.writes = 0;
    fault.next = "crash-before";
    await expect(executeAction(h.deps, { orgId, actionId: id })).rejects.toThrow(/before the write/);
    expect(await onHelpDesk(body)).toBe(0);
    await executeAction(h.deps, { orgId, actionId: id });
    expect(await onHelpDesk(body)).toBe(0);

    // After the safe interval the reply is still absent, so the reconcile job writes it.
    await pastReconcile();
    const a = await actionRow(id);
    expect(a.status).toBe("sent");
    expect(a.sendAttempts).toBe(2);
    expect(fault.writes).toBe(1);
    expect(await onHelpDesk(body)).toBe(1);
    expect(await writesAudited(id)).toHaveLength(1);

    // Later reconcile jobs are no-ops.
    await pastReconcile();
    expect(await onHelpDesk(body)).toBe(1);
  });

  it("concurrent executions of the same action send once", async () => {
    const body = `Concurrent ${randomUUID()}`;
    const id = await approvedReply(body);
    fault.writes = 0;
    fault.next = "slow";
    await Promise.all(Array.from({ length: 5 }, () => executeAction(h.deps, { orgId, actionId: id })));
    expect(fault.writes).toBe(1);
    expect((await actionRow(id)).status).toBe("sent");
    await pastReconcile();
    expect(await onHelpDesk(body)).toBe(1);
    expect(await writesAudited(id)).toHaveLength(1);
  });

  it("a rate limit releases the claim and the job retries after Retry-After", async () => {
    const body = `Rate limited ${randomUUID()}`;
    const id = await approvedReply(body);
    fault.writes = 0;
    fault.next = "rate-limited";
    await h.queue.send("execute-action", { orgId, actionId: id });
    await h.drain();
    expect((await actionRow(id)).status).toBe("approved");
    expect(await onHelpDesk(body)).toBe(0);
    h.clock.advance(30_000);
    await h.drain();
    expect((await actionRow(id)).status).toBe("sent");
    await pastReconcile();
    expect(fault.writes).toBe(1);
    expect(await onHelpDesk(body)).toBe(1);
  });
});
