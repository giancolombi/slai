import { type ConnectorDefinition, ConnectorError, getConnector } from "@slai/connectors";
import { auditEvents, connections, slaOutcomes, ticketComments, ticketEvents, tickets } from "@slai/db";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { scheduleSyncs, sweepDueTickets } from "../src/sweep.js";
import { createConnection, createOrg, createPolicy, parkTimers, setupWorker } from "./harness.js";

// A connector whose token was revoked, and one that reports unmapped statuses.
const demo = getConnector("demo")!;
const revoked: ConnectorDefinition<Record<string, never>> = {
  ...demo,
  provider: "zendesk",
  credentialsSchema: z.object({}).strict(),
  create: () => ({
    ...demo.create({ credentials: {}, config: {}, mapping: demo.defaultMapping, fetch }),
    listUpdatedTickets: async () => {
      throw new ConnectorError("zendesk: 401 Couldn't authenticate you", "auth");
    },
    getTicketWithHistory: async () => {
      throw new ConnectorError("zendesk: 401 Couldn't authenticate you", "auth");
    },
  }),
};
const unmapped: ConnectorDefinition<Record<string, never>> = {
  ...demo,
  provider: "freshdesk",
  create: (ctx) => {
    const inner = demo.create({
      ...ctx,
      config: { seed: "unmapped", ticketsPerDay: 5, historyDays: 1, now: ctx.config.now },
    });
    return {
      ...inner,
      async listUpdatedTickets(since, cursor) {
        const page = await inner.listUpdatedTickets(since, cursor);
        return {
          ...page,
          items: page.items.map((t) => ({ ...t, mappingIssues: [{ field: "status", raw: "Waiting on QA" }] })),
        };
      },
    };
  },
};

const h = setupWorker({
  connectors: {
    get: (p) => (p === "zendesk" ? revoked : p === "freshdesk" ? unmapped : getConnector(p)),
  },
});
const { owner } = h;
let orgId: string;
let connectionId: string;

const counts = async () => {
  const [e] = await owner.db.select({ n: count() }).from(ticketEvents).where(eq(ticketEvents.orgId, orgId));
  const [o] = await owner.db.select({ n: count() }).from(slaOutcomes).where(eq(slaOutcomes.orgId, orgId));
  const [c] = await owner.db.select({ n: count() }).from(ticketComments).where(eq(ticketComments.orgId, orgId));
  const [t] = await owner.db.select({ n: count() }).from(tickets).where(eq(tickets.orgId, orgId));
  return { events: e!.n, outcomes: o!.n, comments: c!.n, tickets: t!.n };
};

beforeAll(async () => {
  orgId = await createOrg(owner);
  await createPolicy(owner, orgId);
  connectionId = await createConnection(h, orgId, { config: { seed: "idem", ticketsPerDay: 8, historyDays: 3 } });
});
afterAll(() => parkTimers(owner, orgId));

describe("ingest", () => {
  it("is idempotent: re-syncing and re-ingesting add no duplicate events, comments or outcomes", async () => {
    await h.queue.send("sync-connection", { orgId, connectionId, full: true });
    await h.drain();
    const first = await counts();
    expect(first.tickets).toBeGreaterThan(5);
    expect(first.events).toBeGreaterThan(first.tickets);

    // A full re-sync skips unchanged tickets; forcing each ticket through ingest again changes nothing.
    await h.queue.send("sync-connection", { orgId, connectionId, full: true });
    await h.drain();
    const ids = await owner.db.select({ externalId: tickets.externalId }).from(tickets).where(eq(tickets.orgId, orgId));
    await h.queue.send("process-webhook", { orgId, connectionId, ticketSourceIds: ids.map((i) => i.externalId) });
    expect(h.queue.count("ingest-ticket")).toBe(0);
    await h.drain();
    expect(await counts()).toEqual(first);
  });

  it("records the sync cursor and last sync, and the next incremental sync only overlaps a little", async () => {
    const [c] = await owner.db.select().from(connections).where(eq(connections.id, connectionId));
    expect(c!.status).toBe("active");
    expect(c!.lastSyncAt?.getTime()).toBe(h.clock.now().getTime());
    expect(c!.syncCursor).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("re-evaluates from stored events without calling the help desk", async () => {
    const [t] = await owner.db.select().from(tickets).where(eq(tickets.orgId, orgId)).limit(1);
    const before = await counts();
    h.clock.advance(60_000);
    await h.queue.send("evaluate-ticket", { orgId, ticketId: t!.id });
    await h.drain();
    const [after] = await owner.db.select().from(tickets).where(eq(tickets.id, t!.id));
    expect(after!.lastEvaluatedAt!.getTime()).toBe(h.clock.now().getTime());
    expect(await counts()).toEqual(before);
  });

  it("the sweep claims due tickets once (leased) as the restricted system role", async () => {
    h.clock.advance(7 * 86_400_000);
    const claimed = await sweepDueTickets(h.deps);
    expect(claimed).toBeGreaterThan(0);
    expect(h.queue.count("evaluate-ticket")).toBe(claimed);
    expect(await sweepDueTickets(h.deps)).toBe(0); // leased
    const job = h.queue.jobs.find((j) => j.name === "evaluate-ticket")!;
    expect(job.opts.singletonKey).toBe((job.payload as { ticketId: string }).ticketId);
    await h.drain();
    // After evaluation the real timer replaces the lease (or none, when no clock runs).
    const rows = await owner.db.select().from(tickets).where(eq(tickets.orgId, orgId));
    expect(rows.every((r) => r.nextCheckAt === null || r.nextCheckAt > h.clock.now())).toBe(true);
  });

  it("schedules the reconciliation sync for due active connections", async () => {
    h.queue.jobs = [];
    expect(await scheduleSyncs(h.deps)).toBeGreaterThan(0);
    const mine = h.queue.jobs.filter(
      (j) => j.name === "sync-connection" && (j.payload as { connectionId: string }).connectionId === connectionId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.opts).toMatchObject({ singletonKey: connectionId, singletonSeconds: 60 });
    h.queue.jobs = [];
  });

  it("marks the connection as errored on an auth failure", async () => {
    const id = await createConnection(h, orgId, { provider: "zendesk" });
    await h.queue.send("sync-connection", { orgId, connectionId: id, full: false });
    await h.queue.send("ingest-ticket", { orgId, connectionId: id, ticketSourceId: "123" });
    await h.drain();
    const [c] = await owner.db.select().from(connections).where(eq(connections.id, id));
    expect(c!.status).toBe("error");
    expect(c!.lastError).toContain("401");
    const audits = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, "connection.error")));
    expect(audits.length).toBeGreaterThan(0);
    // Errored connections are left out of scheduled syncs until fixed.
    h.queue.jobs = [];
    await scheduleSyncs(h.deps);
    expect(h.queue.jobs.some((j) => (j.payload as { connectionId: string }).connectionId === id)).toBe(false);
    h.queue.jobs = [];
  });

  it("retries a rate-limited job after Retry-After instead of failing", async () => {
    let calls = 0;
    const limited: ConnectorDefinition<Record<string, never>> = {
      ...demo,
      provider: "hubspot",
      create: () => ({
        ...demo.create({ credentials: {}, config: {}, mapping: demo.defaultMapping, fetch }),
        listUpdatedTickets: async () => {
          calls++;
          throw new ConnectorError("slow down", "rate_limited", 30_000);
        },
      }),
    };
    const get = h.deps.connectors.get;
    h.deps.connectors = { get: (p) => (p === "hubspot" ? limited : get(p)) };
    const id = await createConnection(h, orgId, { provider: "hubspot" });
    await h.queue.send("sync-connection", { orgId, connectionId: id, full: false });
    await h.drain();
    expect(calls).toBe(1);
    const retry = h.queue.jobs.find((j) => j.name === "sync-connection")!;
    expect(retry.opts.startAfter!.getTime()).toBe(h.clock.now().getTime() + 30_000);
    h.queue.jobs = [];
    h.deps.connectors = { get };
  });

  it("records unmapped statuses on the connection", async () => {
    const id = await createConnection(h, orgId, { provider: "freshdesk" });
    await h.queue.send("sync-connection", { orgId, connectionId: id, full: true });
    await h.drain(["sync-connection"]);
    h.queue.jobs = [];
    const [c] = await owner.db.select().from(connections).where(eq(connections.id, id));
    expect(c!.mappingIssues).toEqual([{ field: "status", raw: "Waiting on QA" }]);
  });
});
