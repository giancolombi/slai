import { agentRuns, auditEvents, tickets, usageLedger } from "@slai/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { sweepDueTickets } from "../src/sweep.js";
import {
  createChannel,
  createConnection,
  createOrg,
  createPolicy,
  createRule,
  type Harness,
  parkTimers,
  setupWorker,
} from "./harness.js";

const h = setupWorker();
const { owner } = h;
const orgs: string[] = [];
afterAll(() => Promise.all(orgs.map((o) => parkTimers(owner, o))));

/** An org on autopilot for everything, synced, then moved a day ahead and swept. */
async function runDay(harness: Harness, capCents: number | null, spentCredits: number) {
  const orgId = await createOrg(owner, { capCents });
  orgs.push(orgId);
  await createPolicy(owner, orgId);
  await createRule(owner, orgId, { customerAccountId: null, level: "autopilot", triggerAt: "warning" });
  await createChannel(harness, orgId, { kind: "email", target: "alerts@example.com", minRisk: "warning" });
  if (spentCredits) {
    await owner.db.insert(usageLedger).values({
      orgId,
      kind: "model_call",
      quantity: 1,
      unit: "tokens",
      credits: spentCredits,
      createdAt: h.clock.now(),
    });
  }
  const connectionId = await createConnection(harness, orgId, {
    config: { seed: `spend-${capCents}-${spentCredits}`, ticketsPerDay: 10, historyDays: 2 },
  });
  await h.queue.send("sync-connection", { orgId, connectionId, full: true });
  await h.drain();
  // The first sync reacts only to still-actionable tickets (TR-21f). Let a few hours pass, with new
  // tickets arriving and the timers firing, so tickets cross their thresholds after connect.
  const start = h.clock.now();
  for (let i = 0; i < 6; i++) {
    h.clock.advance(30 * 60_000);
    await h.queue.send("sync-connection", { orgId, connectionId, full: false });
    await sweepDueTickets(h.deps);
    await h.drain();
  }
  h.clock.set(start);
  return orgId;
}

describe("spend cap", () => {
  it("over the cap, no agent runs, but alerts still go out", async () => {
    const orgId = await runDay(h, 100, 100);
    const runs = await owner.db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(runs).toHaveLength(0);
    const alerts = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "notification.sent")));
    expect(alerts.length).toBeGreaterThan(0);
    // Evaluations were not throttled either.
    const evaluated = await owner.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), isNotNull(tickets.evaluation)));
    expect(evaluated.length).toBeGreaterThan(0);
  });

  it("under the cap, agents run; each 50/80/100% threshold is announced once per month", async () => {
    const orgId = await runDay(h, 200, 90);
    const runs = await owner.db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    expect(runs.length).toBeGreaterThan(0);
    const thresholds = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "usage.cap_threshold")));
    const percents = thresholds.map((t) => (t.metadata as { percent: number }).percent).sort((a, b) => a - b);
    expect(new Set(percents).size).toBe(percents.length);
    expect(percents[0]).toBe(50);
    expect(h.outbox.mail.some((m) => m.subject.includes("of the monthly AI spend cap used"))).toBe(true);
  });
});
