/**
 * T-65: plan ceilings, trial, past-due degradation and the billing snapshot,
 * end to end through the worker. Monitoring and alerts must keep running in
 * every billing state; only agents are limited.
 */
import { randomUUID } from "node:crypto";
import {
  agentActions,
  agentRuns,
  auditEvents,
  billingPeriods,
  memberships,
  organizations,
  tickets,
  usageLedger,
  users,
} from "@slai/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingSnapshotJob, type UsageReporter } from "../src/billing.js";
import { scheduleBilling, sweepDueTickets } from "../src/sweep.js";
import {
  createChannel,
  createConnection,
  createOrg,
  createPolicy,
  createRule,
  parkTimers,
  setupWorker,
} from "./harness.js";

const DAY = 86_400_000;
const reported: Parameters<UsageReporter["reportMeterEvent"]>[0][] = [];
const reporter: UsageReporter = {
  async reportMeterEvent(e) {
    reported.push(e);
  },
};
const h = setupWorker({ usageReporter: reporter });
const { owner } = h;
const orgs: string[] = [];
afterAll(() => Promise.all(orgs.map((o) => parkTimers(owner, o))));

type Billing = NonNullable<Parameters<typeof createOrg>[1]>["billing"];

/** An org with an autopilot rule for everything, synced, then run through a few hours of sweeps. */
async function runDay(billing: Billing, seed: string) {
  const orgId = await createOrg(owner, { billing });
  orgs.push(orgId);
  await createPolicy(owner, orgId);
  await createRule(owner, orgId, { customerAccountId: null, level: "autopilot", triggerAt: "warning" });
  await createChannel(h, orgId, { kind: "email", target: "alerts@example.com", minRisk: "warning" });
  const connectionId = await createConnection(h, orgId, {
    config: { seed: `billing-${seed}`, ticketsPerDay: 10, historyDays: 2 },
  });
  await h.queue.send("sync-connection", { orgId, connectionId, full: true });
  await h.drain();
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

async function monitoring(orgId: string) {
  const alerts = await owner.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "notification.sent")));
  const evaluated = await owner.db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), isNotNull(tickets.evaluation)));
  return { alerts: alerts.length, evaluated: evaluated.length };
}

const runsOf = (orgId: string) => owner.db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));

describe("plan ceilings through the worker", () => {
  it("Starter triages but never drafts, even under an autopilot rule", async () => {
    const orgId = await runDay({ plan: "starter" }, "starter");
    const runs = await runsOf(orgId);
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs.map((r) => r.kind))).toEqual(new Set(["triage"]));
    const replies = await owner.db
      .select()
      .from(agentActions)
      .where(and(eq(agentActions.orgId, orgId), eq(agentActions.kind, "public_reply")));
    expect(replies).toHaveLength(0);
  });

  it("a trial drafts but never runs autopilot", async () => {
    const orgId = await runDay(
      { plan: "growth", billingStatus: "trialing", trialEndsAt: new Date(h.clock.now().getTime() + 10 * DAY) },
      "trial",
    );
    const runs = await runsOf(orgId);
    expect(runs.some((r) => r.kind === "draft_reply")).toBe(true);
    const autoSent = await owner.db
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.orgId, orgId), eq(usageLedger.kind, "autopilot_reply")));
    expect(autoSent).toHaveLength(0);
    const replies = await owner.db
      .select()
      .from(agentActions)
      .where(and(eq(agentActions.orgId, orgId), eq(agentActions.kind, "public_reply")));
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((a) => a.status === "proposed" && (a.payload as { level: string }).level === "assist")).toBe(
      true,
    );
  });
});

describe("degraded states keep monitoring", () => {
  it("after the trial ends, agents are observe-only; evaluation and alerts continue", async () => {
    const orgId = await runDay(
      { plan: "growth", billingStatus: "trialing", trialEndsAt: new Date(h.clock.now().getTime() - DAY) },
      "expired",
    );
    expect(await runsOf(orgId)).toHaveLength(0);
    const m = await monitoring(orgId);
    expect(m.alerts).toBeGreaterThan(0);
    expect(m.evaluated).toBeGreaterThan(0);
  });

  it("past due inside the grace period keeps the plan", async () => {
    const orgId = await runDay(
      { plan: "scale", billingStatus: "past_due", pastDueSince: new Date(h.clock.now().getTime() - 2 * DAY) },
      "grace",
    );
    expect((await runsOf(orgId)).length).toBeGreaterThan(0);
  });

  it("past due beyond the grace period degrades to observe; evaluation and alerts continue", async () => {
    const orgId = await runDay(
      { plan: "scale", billingStatus: "past_due", pastDueSince: new Date(h.clock.now().getTime() - 8 * DAY) },
      "degraded",
    );
    expect(await runsOf(orgId)).toHaveLength(0);
    const m = await monitoring(orgId);
    expect(m.alerts).toBeGreaterThan(0);
    expect(m.evaluated).toBeGreaterThan(0);
  });

  it("canceled is observe-only; monitoring continues", async () => {
    const orgId = await runDay({ plan: "scale", billingStatus: "canceled" }, "canceled");
    expect(await runsOf(orgId)).toHaveLength(0);
    expect((await monitoring(orgId)).alerts).toBeGreaterThan(0);
  });
});

// ---------- the billing snapshot job ----------

async function addOwner(orgId: string) {
  const email = `owner-${randomUUID()}@example.com`;
  const [u] = await owner.db.insert(users).values({ email, name: "Owner" }).returning({ id: users.id });
  await owner.db.insert(memberships).values({ orgId, userId: u!.id, role: "owner" });
  return email;
}

/** `n` tickets, each with one SLA cycle running since `startedAt`. */
async function trackedTickets(orgId: string, n: number, startedAt: Date) {
  const connectionId = await createConnection(h, orgId);
  const iso = startedAt.toISOString();
  await owner.client`
    with t as (
      insert into tickets (org_id, connection_id, external_id, display_key, status, created_at_source, updated_at_source)
      select ${orgId}, ${connectionId}, 'bulk-' || g, '#' || g, 'open', ${iso}::timestamptz, ${iso}::timestamptz
      from generate_series(1, ${n}) g
      returning id
    )
    insert into sla_outcomes (org_id, ticket_id, metric, cycle_index, state, started_at, target_ms, elapsed_ms)
    select ${orgId}, id, 'resolution', 0, 'running', ${iso}::timestamptz, 3600000, 0 from t`;
}

const mailTo = (email: string) => h.outbox.mail.filter((m) => m.to === email);
const actions = async (orgId: string, action: string) =>
  owner.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, action)));

describe("billing snapshot", () => {
  it("closes last month once, reports billable overage to Stripe once, and flags this month's overage once", async () => {
    const orgId = await createOrg(owner, { billing: { plan: "starter", stripeCustomerId: `cus_${randomUUID()}` } });
    const ownerEmail = await addOwner(orgId);
    // Created in August, so September is billed.
    await owner.db
      .update(organizations)
      .set({ createdAt: new Date("2026-08-15T00:00:00Z") })
      .where(eq(organizations.id, orgId));
    await trackedTickets(orgId, 1_600, new Date("2026-09-05T00:00:00Z"));
    await owner.db.insert(usageLedger).values({
      orgId,
      kind: "model_call",
      quantity: 1,
      unit: "tokens",
      credits: 6_000,
      createdAt: new Date("2026-09-20T00:00:00Z"),
    });

    const saved = h.clock.now();
    h.clock.set(new Date("2026-10-02T09:00:00Z"));
    try {
      reported.length = 0;
      await billingSnapshotJob(h.deps, { orgId });
      await billingSnapshotJob(h.deps, { orgId });
    } finally {
      h.clock.set(saved);
    }

    const periods = await owner.db
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.orgId, orgId))
      .orderBy(billingPeriods.periodStart);
    expect(periods).toHaveLength(2);
    const [sep, oct] = periods;
    expect(sep).toMatchObject({
      plan: "starter",
      trackedTickets: 1_600,
      trackedLimit: 1_500,
      ticketOverage: 100,
      creditsUsed: 6_000,
      includedCredits: 5_000,
      creditOverage: 1_000,
      overageCents: 100 * 20 + 1_000,
    });
    expect(sep!.closedAt).not.toBeNull();
    expect(sep!.reportedAt).not.toBeNull();
    // Running cycles are still live in October: tracked there too, and the period stays open.
    expect(oct).toMatchObject({ trackedTickets: 1_600, ticketOverage: 100, closedAt: null });

    const own = reported.filter((e) => e.identifier.startsWith(orgId));
    expect(own.map((e) => [e.eventName, e.value, e.identifier])).toEqual([
      ["slai_tracked_ticket_overage", 100, `${orgId}:2026-09:tickets`],
      ["slai_credit_overage", 1_000, `${orgId}:2026-09:credits`],
    ]);
    expect(own[0]!.timestamp < new Date("2026-10-01T00:00:00Z")).toBe(true);

    expect(await actions(orgId, "billing.period_closed")).toHaveLength(1);
    expect(await actions(orgId, "billing.usage_reported")).toHaveLength(1);
    expect(await actions(orgId, "billing.tracked_overage")).toHaveLength(1);
    const mail = mailTo(ownerEmail);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toMatch(/1,600 SLA-tracked tickets/);
    expect(mail[0]!.text).toMatch(/monitoring and alerts continue/);
  });

  it("in manual mode (no Stripe) the period closes but nothing is reported", async () => {
    const h2 = setupWorker({ usageReporter: null }, new Date("2026-10-02T09:00:00Z"));
    const orgId = await createOrg(h2.owner, { billing: { plan: "starter", stripeCustomerId: null } });
    await h2.owner.db
      .update(organizations)
      .set({ createdAt: new Date("2026-08-15T00:00:00Z") })
      .where(eq(organizations.id, orgId));
    await h2.owner.db.insert(usageLedger).values({
      orgId,
      kind: "model_call",
      quantity: 1,
      unit: "tokens",
      credits: 7_000,
      createdAt: new Date("2026-09-20T00:00:00Z"),
    });
    await billingSnapshotJob(h2.deps, { orgId });
    const [sep] = await h2.owner.db
      .select()
      .from(billingPeriods)
      .where(and(eq(billingPeriods.orgId, orgId), eq(billingPeriods.periodStart, new Date("2026-09-01T00:00:00Z"))));
    expect(sep).toMatchObject({ creditOverage: 2_000, overageCents: 2_000, reportedAt: null });
    expect(sep!.closedAt).not.toBeNull();
  });

  it("warns the owner once at 3 days left, and once when the trial ends", async () => {
    const trialEndsAt = new Date(h.clock.now().getTime() + 2.5 * DAY);
    const orgId = await createOrg(owner, { billing: { plan: "growth", billingStatus: "trialing", trialEndsAt } });
    const ownerEmail = await addOwner(orgId);
    await billingSnapshotJob(h.deps, { orgId });
    await billingSnapshotJob(h.deps, { orgId });
    expect(mailTo(ownerEmail).map((m) => m.subject)).toEqual(["[slai] Your trial ends in 3 days"]);

    const saved = h.clock.now();
    h.clock.set(new Date(trialEndsAt.getTime() + 60_000));
    try {
      await billingSnapshotJob(h.deps, { orgId });
      await billingSnapshotJob(h.deps, { orgId });
    } finally {
      h.clock.set(saved);
    }
    expect(mailTo(ownerEmail).map((m) => m.subject)).toEqual([
      "[slai] Your trial ends in 3 days",
      "[slai] Your trial has ended: agents are paused, alerts continue",
    ]);
    // A trial with plenty left says nothing.
    const fresh = await createOrg(owner, {
      billing: { plan: "growth", billingStatus: "trialing", trialEndsAt: new Date(h.clock.now().getTime() + 10 * DAY) },
    });
    const freshEmail = await addOwner(fresh);
    await billingSnapshotJob(h.deps, { orgId: fresh });
    expect(mailTo(freshEmail)).toHaveLength(0);
  });

  it("tells the owner once when a past-due account degrades", async () => {
    const orgId = await createOrg(owner, {
      billing: { plan: "scale", billingStatus: "past_due", pastDueSince: new Date(h.clock.now().getTime() - 8 * DAY) },
    });
    const ownerEmail = await addOwner(orgId);
    await billingSnapshotJob(h.deps, { orgId });
    await billingSnapshotJob(h.deps, { orgId });
    const mail = mailTo(ownerEmail);
    expect(mail.map((m) => m.subject)).toEqual(["[slai] Payment past due: agents are paused, alerts continue"]);
    expect(mail[0]!.text).toMatch(/monitoring and alerts continue/);
  });

  it("is scheduled per org; an org created this month has only its open period", async () => {
    const orgId = await createOrg(owner);
    await scheduleBilling(h.deps);
    expect(
      h.queue.jobs.some((j) => j.name === "billing-snapshot" && (j.payload as { orgId: string }).orgId === orgId),
    ).toBe(true);
    await h.drain(["billing-snapshot"]);
    const rows = await owner.db.select().from(billingPeriods).where(eq(billingPeriods.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closedAt).toBeNull();
  });
});
