import {
  type CanonicalEvent,
  type ConnectorDefinition,
  getConnector,
  mapPriority,
  mapStatus,
  type TicketWithHistory,
} from "@slai/connectors";
import { connections, ticketEvents, tickets } from "@slai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createConnection, createOrg, createPolicy, parkTimers, setupWorker } from "./harness.js";

const START = new Date("2026-09-29T14:00:00Z");
const at = (minutesAgo: number) => new Date(START.getTime() - minutesAgo * 60_000);

/**
 * A help desk with one ticket that moved to a custom status, "Awaiting Vendor",
 * which the shipped mapping doesn't know (so it counts as open). The connector
 * maps with whatever mapping the worker hands it, like every real connector.
 */
const demo = getConnector("demo")!;
const custom: ConnectorDefinition<Record<string, never>> = {
  ...demo,
  provider: "servicenow",
  credentialsSchema: z.object({}).strict(),
  defaultMapping: {
    status: { New: "new", Open: "open", Closed: "closed" },
    priority: { "1": "urgent", "3": "normal" },
  },
  create: (ctx) => {
    const history = (): TicketWithHistory => {
      const s1 = mapStatus(ctx.mapping, "New");
      const s2 = mapStatus(ctx.mapping, "Awaiting Vendor");
      const p = mapPriority(ctx.mapping, "3");
      const events: CanonicalEvent[] = [
        { type: "created", status: s1.value, priority: p.value, at: at(180), idempotencyKey: "sn:1:created" },
        {
          type: "status_changed",
          status: s2.value,
          rawStatus: "Awaiting Vendor",
          at: at(120),
          idempotencyKey: "sn:1:s2",
        },
      ];
      return {
        ticket: {
          ref: { sourceId: "INC001", displayKey: "INC001", url: null },
          subject: "VPN down",
          status: s2.value,
          rawStatus: "Awaiting Vendor",
          priority: p.value,
          rawPriority: "3",
          requester: { sourceId: null, email: "cto@acme.test", name: null, orgSourceId: null, orgName: null },
          assignee: null,
          groupSourceId: null,
          tags: [],
          channel: null,
          createdAt: at(180),
          updatedAt: at(120),
          mappingIssues: s2.known ? [] : [{ field: "status", raw: "Awaiting Vendor" }],
        },
        events,
        comments: [],
      };
    };
    return {
      ...demo.create({ credentials: {}, config: {}, mapping: demo.defaultMapping, fetch }),
      listUpdatedTickets: async () => ({ items: [history().ticket], nextCursor: null }),
      getTicketWithHistory: async () => history(),
    };
  },
};

const h = setupWorker({ connectors: { get: (p) => (p === "servicenow" ? custom : getConnector(p)) } }, START);
const { owner } = h;
let orgId: string;
let connectionId: string;

const ticket = async () => {
  const [t] = await owner.db.select().from(tickets).where(eq(tickets.connectionId, connectionId));
  return t!;
};
const resolution = async () => {
  const t = await ticket();
  return (t.evaluation as { metrics: { metric: string; state: string }[] }).metrics.find(
    (m) => m.metric === "resolution",
  )!.state;
};

beforeAll(async () => {
  orgId = await createOrg(owner);
  await createPolicy(owner, orgId);
  connectionId = await createConnection(h, orgId, { provider: "servicenow" });
  await h.queue.send("sync-connection", { orgId, connectionId, full: true });
  await h.drain();
});
afterAll(() => parkTimers(owner, orgId));

describe("re-evaluation after a mapping change (T-25)", () => {
  it("an unmapped status counts as open, so the resolution clock runs", async () => {
    expect((await ticket()).status).toBe("open");
    expect(await resolution()).toBe("running");
    const [c] = await owner.db.select().from(connections).where(eq(connections.id, connectionId));
    expect(c!.mappingIssues).toEqual([{ field: "status", raw: "Awaiting Vendor" }]);
  });

  it("re-ingests after the override: the stored event is re-mapped and the clock pauses", async () => {
    await owner.db
      .update(connections)
      .set({ mapping: { status: { "Awaiting Vendor": "on_hold" }, priority: {} } })
      .where(eq(connections.id, connectionId));
    await h.queue.send("remap-connection", { orgId, connectionId });
    await h.drain();

    expect(h.queue.sent.filter((j) => j.name === "ingest-ticket").length).toBeGreaterThanOrEqual(2);
    const t = await ticket();
    expect(t.status).toBe("on_hold");
    expect(await resolution()).toBe("paused");
    const [ev] = await owner.db
      .select()
      .from(ticketEvents)
      .where(and(eq(ticketEvents.ticketId, t.id), eq(ticketEvents.idempotencyKey, "sn:1:s2")));
    expect(ev!.payload).toMatchObject({ status: "on_hold", rawStatus: "Awaiting Vendor" });
    // Still one row per source event.
    const all = await owner.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, t.id));
    expect(all).toHaveLength(2);
  });

  it("re-ingests closed tickets only when their raw values now map differently", async () => {
    const ingests = async (mapping: { status: Record<string, "closed" | "on_hold">; priority: object }) => {
      await owner.db.update(connections).set({ mapping }).where(eq(connections.id, connectionId));
      const before = h.queue.sent.length;
      await h.queue.send("remap-connection", { orgId, connectionId });
      await h.drain();
      return h.queue.sent.slice(before).filter((j) => j.name === "ingest-ticket").length;
    };
    expect(await ingests({ status: { "Awaiting Vendor": "closed" }, priority: {} })).toBe(1);
    expect((await ticket()).status).toBe("closed");
    // Unchanged for this closed ticket: left alone.
    expect(await ingests({ status: { "Awaiting Vendor": "closed" }, priority: { "3": "high" } })).toBe(1);
    expect((await ticket()).priority).toBe("high");
    expect(await ingests({ status: { "Awaiting Vendor": "closed" }, priority: { "3": "high" } })).toBe(0);
    // Reset to the defaults: the raw status is unmapped again, so the ticket reopens.
    expect(await ingests({ status: {}, priority: {} })).toBe(1);
    expect((await ticket()).status).toBe("open");
  });
});
