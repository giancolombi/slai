import { auditEvents, connections, tickets } from "@slai/db";
import type { Connection, ConnectionMapping } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeConnector, seedTicket } from "./fixtures.js";
import { addMember, fakeRegistry, setupApp, signup } from "./harness.js";

// The fake connector ships { status: { open: "open" }, priority: { high: "high" } }.
const ctx = setupApp({ connectors: fakeRegistry([fakeConnector()]) });
let owner: Awaited<ReturnType<typeof signup>>;
let conn: Connection;

beforeAll(async () => {
  owner = await signup(ctx, "Mapper");
  const res = await owner.client.post<Connection>("/connections", {
    provider: "zendesk",
    name: "Support",
    credentials: { subdomain: "acme", token: "zd-token-123" },
  });
  conn = res.body;
  // What sync found: two unknown statuses and an unknown priority, on stored tickets too.
  await ctx.owner.db
    .update(connections)
    .set({
      mappingIssues: [
        { field: "status", raw: "Waiting on QA" },
        { field: "status", raw: "Escalated" },
        { field: "priority", raw: "P0" },
      ],
    })
    .where(eq(connections.id, conn.id));
  for (const [rawStatus, rawPriority] of [
    ["Waiting on QA", "P0"],
    ["open", "high"],
    ["open", null],
  ] as const) {
    const t = await seedTicket(ctx, owner.orgId, { connectionId: conn.id });
    await ctx.owner.db.update(tickets).set({ rawStatus, rawPriority }).where(eq(tickets.id, t.ticketId));
  }
});

const url = () => `/connections/${conn.id}/mapping`;

describe("connection mapping (T-25)", () => {
  it("returns defaults, overrides, unmapped values and the raw values seen on tickets", async () => {
    const res = await owner.client.get<ConnectionMapping>(url());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaults: { status: { open: "open" }, priority: { high: "high" } },
      overrides: { status: {}, priority: {} },
      unmapped: [
        { field: "status", raw: "Waiting on QA" },
        { field: "status", raw: "Escalated" },
        { field: "priority", raw: "P0" },
      ],
      observed: { status: ["open", "Waiting on QA"], priority: ["high", "P0"] },
    });
    // Viewers can read it.
    const viewer = await addMember(ctx, owner.orgId, "viewer");
    expect((await viewer.client.get(url())).status).toBe(200);
  });

  it("validates against the canonical statuses and priorities", async () => {
    for (const bad of [
      { status: { "Waiting on QA": "waiting" } },
      { priority: { P0: "p0" } },
      { status: { "": "open" } },
      { status: "open" },
    ]) {
      const res = await owner.client.put(url(), bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_body");
    }
  });

  it("is admin-only to change", async () => {
    const member = await addMember(ctx, owner.orgId, "member");
    expect((await member.client.put(url(), { status: { Escalated: "open" } })).status).toBe(403);
  });

  it("saves overrides, clears what is now mapped, audits, and enqueues a re-evaluation", async () => {
    const res = await owner.client.put<ConnectionMapping>(url(), {
      status: { "Waiting on QA": "on_hold", open: "open" },
      priority: { P0: "urgent", high: "high" },
    });
    expect(res.status).toBe(200);
    // Entries equal to the defaults aren't stored as overrides.
    expect(res.body.overrides).toEqual({ status: { "Waiting on QA": "on_hold" }, priority: { P0: "urgent" } });
    expect(res.body.unmapped).toEqual([{ field: "status", raw: "Escalated" }]);
    const [row] = await ctx.owner.db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row!.mapping).toEqual({ status: { "Waiting on QA": "on_hold" }, priority: { P0: "urgent" } });
    expect(row!.mappingIssues).toEqual([{ field: "status", raw: "Escalated" }]);

    const [audit] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, conn.id), eq(auditEvents.action, "connection.mapping_updated")));
    expect(audit!.actorId).toBe(owner.userId);
    expect(audit!.metadata).toMatchObject({ reset: false, after: res.body.overrides });

    const jobs = await ctx.owner.client`
      select data from pgboss.job where name = 'remap-connection' and data->>'connectionId' = ${conn.id}`;
    expect(jobs.map((j) => j.data)).toEqual([{ orgId: owner.orgId, connectionId: conn.id }]);
    expect((await owner.client.get<ConnectionMapping>(url())).body.overrides).toEqual(res.body.overrides);
  });

  it("resets to the default mapping", async () => {
    const res = await owner.client.put<ConnectionMapping>(url(), { status: {}, priority: {} });
    expect(res.body.overrides).toEqual({ status: {}, priority: {} });
    const audits = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, conn.id), eq(auditEvents.action, "connection.mapping_updated")));
    expect(audits.at(-1)!.metadata).toMatchObject({ reset: true });
  });

  it("is org-scoped", async () => {
    const stranger = await signup(ctx, "Other");
    expect((await stranger.client.get(url())).status).toBe(404);
    expect((await stranger.client.put(url(), { status: {} })).status).toBe(404);
  });
});
