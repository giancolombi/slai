/**
 * T-60 core, end to end against Postgres: demo help desk → sync → evaluation →
 * time passes → sweep → risk crossing → alerts → agents → assist proposal and
 * autopilot send through the connector → audit and metering → approval → send.
 */
import { randomUUID } from "node:crypto";
import { agentActions, agentRuns, auditEvents, slaOutcomes, ticketEvents, tickets, usageLedger, users } from "@slai/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueTickets } from "../src/sweep.js";
import {
  createChannel,
  createConnection,
  createCustomer,
  createOrg,
  createPolicy,
  createRule,
  parkTimers,
  setupWorker,
} from "./harness.js";
import { DEMO, findScenario, knowledgeFor, type Scenario } from "./scenario.js";

const h = setupWorker({
  resources: async (_orgId, t) => ({ knowledge: knowledgeFor(t.subject), assignees: [] }),
});
const { owner } = h;
let s: Scenario;
let orgId: string;
let connectionId: string;
let autopilotCustomer: string;
let assistCustomer: string;

const ticketBySource = async (sourceId: string) => {
  const [t] = await owner.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.connectionId, connectionId), eq(tickets.externalId, sourceId)));
  return t!;
};

beforeAll(async () => {
  s = await findScenario(new Date("2026-09-29T20:00:00Z"));
  h.clock.set(s.t0);
  orgId = await createOrg(owner);
  connectionId = await createConnection(h, orgId, { config: { ...DEMO } });
  await createPolicy(owner, orgId);
  autopilotCustomer = await createCustomer(owner, orgId, {
    name: "Autopilot Co",
    domains: [s.autopilot.orgDomain],
    fee: 500_000,
  });
  assistCustomer = await createCustomer(owner, orgId, {
    name: "Assist Co",
    domains: [s.assist.orgDomain],
    fee: 300_000,
  });
  await createRule(owner, orgId, { customerAccountId: autopilotCustomer, level: "autopilot" });
  await createRule(owner, orgId, { customerAccountId: assistCustomer, level: "assist" });
  await createChannel(h, orgId, { kind: "email", target: "oncall@example.com", minRisk: "at_risk" });
  await createChannel(h, orgId, {
    kind: "slack_webhook",
    target: "https://hooks.slack.com/services/T000/B000/XXXX",
    minRisk: "at_risk",
  });
});
afterAll(() => parkTimers(owner, orgId));

describe("end to end with the demo help desk", () => {
  it("syncs and evaluates tickets with outcomes and timers", async () => {
    await h.queue.send("sync-connection", { orgId, connectionId, full: true });
    await h.drain();

    const rows = await owner.db.select().from(tickets).where(eq(tickets.orgId, orgId));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((t) => t.evaluation !== null && t.lastEvaluatedAt !== null)).toBe(true);
    const outcomes = await owner.db.select().from(slaOutcomes).where(eq(slaOutcomes.orgId, orgId));
    expect(outcomes.length).toBeGreaterThan(rows.length);

    for (const c of [s.autopilot, s.assist]) {
      const t = await ticketBySource(c.sourceId);
      expect(t.risk).toBe("ok");
      expect(t.status === "new" || t.status === "open").toBe(true);
      expect(t.nextCheckAt).not.toBeNull();
      expect(t.nextCheckAt!.getTime()).toBeLessThanOrEqual(c.atRiskAt.getTime());
      expect(t.nextCheckAt!.getTime()).toBeGreaterThan(s.t0.getTime());
    }
    expect((await ticketBySource(s.autopilot.sourceId)).customerAccountId).toBe(autopilotCustomer);
    expect((await ticketBySource(s.assist.sourceId)).customerAccountId).toBe(assistCustomer);
  });

  it("the sweep catches the at-risk crossing and dispatches alerts and agents", async () => {
    const mailBefore = h.outbox.mail.length;
    h.clock.set(s.t1);
    const claimed = await sweepDueTickets(h.deps);
    expect(claimed).toBeGreaterThanOrEqual(2);
    await h.drain();

    const a = await ticketBySource(s.autopilot.sourceId);
    const b = await ticketBySource(s.assist.sourceId);

    // Alerts: once per crossing, per channel, recorded in the audit log.
    const notes = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "notification.sent")));
    for (const t of [a, b]) {
      const mine = notes.filter((n) => n.targetId === t.id);
      expect(mine).toHaveLength(2);
      expect(mine.map((n) => (n.metadata as { to: string }).to)).toEqual(["at_risk", "at_risk"]);
    }
    const newMail = h.outbox.mail.slice(mailBefore);
    expect(newMail.some((m) => m.subject.includes(a.displayKey) && m.to === "oncall@example.com")).toBe(true);
    expect(
      h.outbox.slack.some((p) => p.url.startsWith("https://hooks.slack.com/") && p.body.includes(b.displayKey)),
    ).toBe(true);

    // Agent runs: triage + draft for each ticket, metered.
    const runs = await owner.db
      .select()
      .from(agentRuns)
      .where(inArray(agentRuns.ticketId, [a.id, b.id]));
    for (const t of [a, b]) {
      const mine = runs.filter((r) => r.ticketId === t.id);
      expect(mine.map((r) => `${r.kind}:${r.status}`).sort()).toEqual(["draft_reply:succeeded", "triage:succeeded"]);
      expect(mine.every((r) => r.provider === "mock" && r.inputTokens > 0)).toBe(true);
    }

    // Assist: a proposed reply for a human, plus an internal note sent right away.
    const bActions = await owner.db.select().from(agentActions).where(eq(agentActions.ticketId, b.id));
    const bReply = bActions.find((x) => x.kind === "public_reply")!;
    expect(bReply.status).toBe("proposed");
    expect(bReply.body).toBeTruthy();
    const bNote = bActions.find((x) => x.kind === "internal_note")!;
    expect(bNote.status).toBe("sent");
    expect(bNote.externalRef).toBeTruthy();
    expect(bNote.body).toContain("Proposed reply:");

    // Autopilot: the reply passed the guardrails and was sent through the demo connector.
    const aActions = await owner.db.select().from(agentActions).where(eq(agentActions.ticketId, a.id));
    const aReply = aActions.find((x) => x.kind === "public_reply")!;
    expect(aReply.status).toBe("sent");
    expect(aReply.externalRef).toMatch(/-w\d+$/);
    expect(aActions.some((x) => x.kind === "internal_note")).toBe(false);

    // Every help-desk write is audited with its actor.
    const writes = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "action.sent")));
    expect(writes.find((w) => w.targetId === aReply.id)?.actorType).toBe("agent");
    expect(writes.find((w) => w.targetId === bNote.id)?.actorType).toBe("agent");

    // The sent reply came back through ingest and stopped the first-response clock.
    const events = await owner.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, a.id));
    expect(events.some((e) => e.type === "comment" && e.at.getTime() === s.t1.getTime())).toBe(true);
    const fr = await owner.db
      .select()
      .from(slaOutcomes)
      .where(and(eq(slaOutcomes.ticketId, a.id), eq(slaOutcomes.metric, "first_response")));
    expect(fr[0]?.state).toBe("achieved");

    // Metering: triage 3 + draft 20 each, plus 60 for the autopilot reply.
    const ledger = await owner.db
      .select()
      .from(usageLedger)
      .where(inArray(usageLedger.ticketId, [a.id, b.id]));
    const credits = (id: string) => ledger.filter((l) => l.ticketId === id).reduce((n, l) => n + l.credits, 0);
    expect(credits(a.id)).toBe(3 + 20 + 60);
    expect(credits(b.id)).toBe(3 + 20);
    expect(ledger.filter((l) => l.kind === "model_call").every((l) => l.quantity > 0)).toBe(true);
  });

  it("does not dispatch again on the next evaluation (once per crossing)", async () => {
    const b = await ticketBySource(s.assist.sourceId);
    await h.queue.send("evaluate-ticket", { orgId, ticketId: b.id });
    await h.drain();
    const runs = await owner.db.select().from(agentRuns).where(eq(agentRuns.ticketId, b.id));
    expect(runs).toHaveLength(2);
  });

  it("sends a human-approved reply through the connector and audits the user", async () => {
    const b = await ticketBySource(s.assist.sourceId);
    const userId = randomUUID();
    await owner.db.insert(users).values({ id: userId, email: `${userId}@example.com`, name: "Approver" });
    const [reply] = await owner.db
      .update(agentActions)
      .set({ status: "approved", decidedBy: userId, decidedAt: h.clock.now() })
      .where(and(eq(agentActions.ticketId, b.id), eq(agentActions.kind, "public_reply")))
      .returning();
    await h.queue.send("execute-action", { orgId, actionId: reply!.id });
    await h.drain();

    const [after] = await owner.db.select().from(agentActions).where(eq(agentActions.id, reply!.id));
    expect(after!.status).toBe("sent");
    expect(after!.externalRef).toBeTruthy();
    const [write] = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "action.sent"), eq(auditEvents.targetId, reply!.id)));
    expect(write!.actorType).toBe("user");
    expect(write!.actorId).toBe(userId);
    const [fr] = await owner.db
      .select()
      .from(slaOutcomes)
      .where(and(eq(slaOutcomes.ticketId, b.id), eq(slaOutcomes.metric, "first_response")));
    expect(fr!.state).toBe("achieved");
  });
});
