import { agentActions, auditEvents, notificationChannels, notifyEvent, usageLedger } from "@slai/db";
import type { AgentAction, DashboardSummary, Policy, TicketDetail, TicketSummary, UsageSummary } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { policyInput, seedTicket } from "./fixtures.js";
import { addMember, setupApp, signup } from "./harness.js";

const ctx = setupApp();
let owner: Awaited<ReturnType<typeof signup>>;
let policy: Policy;
let customerId: string;
let ticketId: string;
let connectionId: string;
// Mid-month so "this period" is stable whenever the suite runs.
const now = new Date();
const midMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12));

beforeAll(async () => {
  owner = await signup(ctx);
  policy = (
    await owner.client.post<Policy>("/policies", { name: "Enterprise", definition: policyInput(), isDefault: true })
  ).body;
  await owner.client.post(`/policies/${policy.id}/approve`);
  customerId = (
    await owner.client.post("/customers", { name: "Globex", monthlyFeeCents: 100_000, policyId: policy.id })
  ).body.id;
  ({ ticketId, connectionId } = await seedTicket(ctx, owner.orgId, {
    policyId: policy.id,
    customerAccountId: customerId,
    risk: "at_risk",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    now: midMonth,
    outcomes: [
      { metric: "first_response", state: "breached" },
      { metric: "resolution", state: "achieved" },
    ],
  }));
});

describe("tickets", () => {
  it("lists with filters and search", async () => {
    await seedTicket(ctx, owner.orgId, { connectionId, subject: "Billing 100%_off question" });
    const all = await owner.client.get<{ items: TicketSummary[] }>("/tickets");
    expect(all.body.items.length).toBe(2);
    const risky = await owner.client.get<{ items: TicketSummary[] }>("/tickets?risk=at_risk");
    expect(risky.body.items.map((t) => t.id)).toEqual([ticketId]);
    expect(risky.body.items[0]).toMatchObject({
      provider: "demo",
      customer: { id: customerId, name: "Globex" },
      policy: { id: policy.id, name: "Enterprise" },
    });
    const q = await owner.client.get<{ items: TicketSummary[] }>(`/tickets?q=${encodeURIComponent("100%_off")}`);
    expect(q.body.items).toHaveLength(1);
    expect((await owner.client.get("/tickets?risk=nope")).status).toBe(400);
  });

  it("paginates with a cursor", async () => {
    const p1 = await owner.client.get<{ items: TicketSummary[]; nextCursor: string }>("/tickets?limit=1");
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await owner.client.get<{ items: TicketSummary[]; nextCursor: string | null }>(
      `/tickets?limit=1&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.items[0]!.id).not.toBe(p1.body.items[0]!.id);
    expect(p2.body.nextCursor).toBeNull();
  });

  it("returns detail with engine-computed metrics and a timeline", async () => {
    const res = await owner.client.get<TicketDetail>(`/tickets/${ticketId}`);
    expect(res.status).toBe(200);
    const fr = res.body.metrics.find((m) => m.metric === "first_response")!;
    // Urgent first response: 60 calendar minutes, no reply for 3h → breached by the engine.
    expect(fr).toMatchObject({ state: "breached", targetMs: 3_600_000, risk: "breached" });
    expect(res.body.timeline.map((e) => e.type)).toEqual(
      expect.arrayContaining(["created", "status_changed", "sla_breached"]),
    );
    expect(res.body.requester.email).toBe("pat@globex.com");
  });

  it("queues an agent run", async () => {
    const res = await owner.client.post(`/tickets/${ticketId}/agents/triage`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: "triage", status: "queued", costCents: 0 });
    const [job] = await ctx.owner.client`select name from pgboss.job where data->>'runId' = ${res.body.id}`;
    expect(job?.name).toBe("run-agent");
    expect((await owner.client.post(`/tickets/${ticketId}/agents/hack`)).status).toBe(404);
  });
});

describe("actions", () => {
  it("approves once (with an edited body), audits, and enqueues execution", async () => {
    const [a] = await ctx.owner.db
      .insert(agentActions)
      .values({ orgId: owner.orgId, ticketId, kind: "public_reply", body: "Draft", confidence: 0.9 })
      .returning();
    const list = await owner.client.get<{ items: AgentAction[] }>("/actions?status=proposed");
    expect(list.body.items.map((x) => x.id)).toContain(a!.id);
    const res = await owner.client.post<AgentAction>(`/actions/${a!.id}/approve`, { body: "Edited reply" });
    expect(res.body).toMatchObject({
      status: "approved",
      body: "Edited reply",
      decidedBy: owner.userId,
      decidedByName: "Ada",
    });
    const approved = await owner.client.get<{ items: AgentAction[] }>("/actions?status=approved");
    expect(approved.body.items.find((x) => x.id === a!.id)).toMatchObject({ decidedByName: "Ada" });
    const detail = await owner.client.get<TicketDetail>(`/tickets/${ticketId}`);
    expect(detail.body.actions.find((x) => x.id === a!.id)).toMatchObject({ decidedByName: "Ada" });
    expect((await owner.client.post(`/actions/${a!.id}/reject`, {})).status).toBe(409);
    const [job] = await ctx.owner.client`select name from pgboss.job where data->>'actionId' = ${a!.id}`;
    expect(job?.name).toBe("execute-action");
    const [ev] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.action, "action.approved")));
    expect(ev!.metadata).toMatchObject({ kind: "public_reply", edited: true });
  });

  it("viewers cannot approve", async () => {
    const [a] = await ctx.owner.db
      .insert(agentActions)
      .values({ orgId: owner.orgId, ticketId, kind: "internal_note" })
      .returning();
    const viewer = await addMember(ctx, owner.orgId, "viewer");
    expect((await viewer.client.post(`/actions/${a!.id}/approve`, {})).status).toBe(403);
  });
});

describe("dashboard and usage", () => {
  it("computes attainment and exposure with the engine's credit rules", async () => {
    ctx.clock.now = midMonth;
    try {
      const res = await owner.client.get<DashboardSummary>("/dashboard");
      expect(res.status).toBe(200);
      expect(res.body.breachesThisPeriod).toBe(1);
      expect(res.body.attainmentPercent).toBe(50);
      // Enterprise credits on a $1,000 fee: urgent first-response breach 5% ($50) +
      // attainment below 90% tier 25% ($250).
      expect(res.body.exposureCents).toBe(30_000);
      expect(res.body.byRisk.at_risk).toBe(1);
      expect(res.body.dueSoon.length).toBeGreaterThan(0);
      expect(res.body.attainmentTrend).toHaveLength(14);
    } finally {
      ctx.clock.now = null;
    }
  });

  it("summarizes metered usage", async () => {
    await ctx.owner.db.insert(usageLedger).values([
      { orgId: owner.orgId, kind: "model_call", quantity: 1200, unit: "tokens", costMicros: 25_000, credits: 1 },
      { orgId: owner.orgId, kind: "sandbox_seconds", quantity: 30, unit: "seconds", costMicros: 5_000 },
    ]);
    const res = await owner.client.get<UsageSummary>("/usage");
    expect(res.body).toMatchObject({ costCents: 3, creditsUsed: 1 });
    expect(res.body.byKind).toEqual(
      expect.arrayContaining([{ kind: "model_call", count: 1, credits: 1, costCents: 3 }]),
    );
  });
});

describe("notification channels", () => {
  it("encrypts Slack webhook URLs and only returns them masked", async () => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXXsecretABCD";
    const res = await owner.client.post("/notification-channels", { kind: "slack_webhook", target: url });
    expect(res.status).toBe(201);
    expect(res.body.target).toBe("https://hooks.slack.com/services/…ABCD");
    const [row] = await ctx.owner.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, res.body.id));
    expect(row!.target).toMatch(/^v1\.k1\./);
    expect(JSON.stringify((await owner.client.get("/notification-channels")).body)).not.toContain("XXXXsecret");
    expect(
      (await owner.client.post("/notification-channels", { kind: "slack_webhook", target: "https://evil.example" }))
        .status,
    ).toBe(400);
  });
});

describe("server-sent events", () => {
  it("forwards only the session org's events", async () => {
    const other = await signup(ctx, "Other");
    const res = await ctx.app.request("/api/v1/events", { headers: { cookie: owner.client.cookie! } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!text.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil("event: ready");
    // Give the LISTEN connection a moment to be established.
    await new Promise((r) => setTimeout(r, 200));
    await notifyEvent(ctx.owner.db, { orgId: other.orgId, type: "ticket.updated", id: "other-org-ticket" });
    await notifyEvent(ctx.owner.db, { orgId: owner.orgId, type: "ticket.updated", id: "my-ticket" });
    await readUntil("my-ticket");
    await reader.cancel();
    expect(text).toContain('event: ticket.updated\ndata: {"id":"my-ticket"}');
    expect(text).not.toContain("other-org-ticket");
  });

  /** An open `/events` stream for a signed-in client, read as text. */
  async function openStream(cookie: string) {
    const res = await ctx.app.request("/api/v1/events", { headers: { cookie } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const s = { text: "" };
    const readUntil = async (needle: string, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!s.text.includes(needle) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
        ]);
        if (!next || next.done) break;
        s.text += decoder.decode(next.value);
      }
      return s.text.includes(needle);
    };
    return { s, readUntil, close: () => reader.cancel() };
  }

  it("delivers a real change (an approval) to its own org's open stream only", async () => {
    const other = await signup(ctx, "Other");
    const mine = await openStream(owner.client.cookie!);
    const theirs = await openStream(other.client.cookie!);
    expect(await mine.readUntil("event: ready")).toBe(true);
    expect(await theirs.readUntil("event: ready")).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const [a] = await ctx.owner.db
      .insert(agentActions)
      .values({ orgId: owner.orgId, ticketId, kind: "public_reply", body: "Stream me", confidence: 0.9 })
      .returning();
    expect((await owner.client.post(`/actions/${a!.id}/approve`, {})).status).toBe(200);
    // A NOTIFY addressed to the other org goes to its stream, not ours.
    await notifyEvent(ctx.owner.db, { orgId: other.orgId, type: "replay.progress", id: "their-replay" });

    expect(await mine.readUntil(`event: action.updated\ndata: {"id":"${a!.id}"}`)).toBe(true);
    expect(await mine.readUntil(`event: ticket.updated\ndata: {"id":"${ticketId}"}`)).toBe(true);
    expect(await theirs.readUntil("their-replay")).toBe(true);
    // Give any stray delivery a moment to arrive before asserting its absence.
    await theirs.readUntil(a!.id, 300);
    await mine.readUntil("their-replay", 300);
    await Promise.all([mine.close(), theirs.close()]);
    expect(theirs.s.text).not.toContain(a!.id);
    expect(theirs.s.text).not.toContain(ticketId);
    expect(mine.s.text).not.toContain("their-replay");
  });
});
