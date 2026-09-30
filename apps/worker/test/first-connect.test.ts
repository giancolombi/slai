/**
 * T-48: connecting a help desk full of long-overdue tickets must not fire a
 * burst of alerts and drafts. Only still-actionable crossings react on a
 * ticket's first evaluation; later crossings react as usual.
 */
import { agentRuns, auditEvents, fromStoredEvaluation, type StoredEvaluation, tickets } from "@slai/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionableRisk, FIRST_SEEN_GRACE_MS } from "../src/decide.js";
import { sweepDueTickets } from "../src/sweep.js";
import {
  createChannel,
  createConnection,
  createOrg,
  createPolicy,
  createRule,
  parkTimers,
  setupWorker,
} from "./harness.js";
import { DEMO, findScenario, type Scenario } from "./scenario.js";

const h = setupWorker();
const { owner } = h;
let s: Scenario;
let orgId: string;
let connectionId: string;
let longBreached: string[] = [];

const ticketBySource = async (sourceId: string) => {
  const [t] = await owner.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.connectionId, connectionId), eq(tickets.externalId, sourceId)));
  return t!;
};

const notified = async (ids: string[]) =>
  ids.length
    ? owner.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, orgId),
            eq(auditEvents.action, "notification.sent"),
            inArray(auditEvents.targetId, ids),
          ),
        )
    : [];

beforeAll(async () => {
  s = await findScenario(new Date("2026-09-29T20:00:00Z"));
  h.clock.set(s.t0);
  orgId = await createOrg(owner);
  connectionId = await createConnection(h, orgId, { config: { ...DEMO, seed: DEMO.seed } });
  await createPolicy(owner, orgId);
  // Every ticket in the org is on assist, and every at-risk crossing alerts.
  await createRule(owner, orgId, { customerAccountId: null, level: "assist" });
  await createChannel(h, orgId, { kind: "email", target: "oncall@example.com", minRisk: "at_risk" });
});
afterAll(() => parkTimers(owner, orgId));

describe("first-connect guard", () => {
  it("a fresh connection dispatches nothing for tickets breached long before slai saw them", async () => {
    await h.queue.send("sync-connection", { orgId, connectionId, full: true });
    await h.drain();

    const rows = await owner.db.select().from(tickets).where(eq(tickets.orgId, orgId));
    const open = rows.filter((t) => t.status !== "solved" && t.status !== "closed");
    longBreached = open
      .filter((t) => {
        if (t.risk !== "breached" || !t.evaluation) return false;
        const ev = fromStoredEvaluation(t.evaluation as StoredEvaluation);
        return actionableRisk(ev.metrics, h.clock.now(), FIRST_SEEN_GRACE_MS) === "ok";
      })
      .map((t) => t.id);
    // The demo backlog has plenty of open, long-overdue tickets: exactly the burst this guards against.
    expect(longBreached.length).toBeGreaterThanOrEqual(5);

    const runs = await owner.db.select().from(agentRuns).where(inArray(agentRuns.ticketId, longBreached));
    expect(runs).toEqual([]);
    expect(await notified(longBreached)).toEqual([]);
    const mailed = h.outbox.mail.filter((m) =>
      rows.some((t) => longBreached.includes(t.id) && m.subject.includes(t.displayKey)),
    );
    expect(mailed).toEqual([]);

    // Whatever did react on first sight was still actionable (at risk, or breached within the grace window).
    const allRuns = await owner.db.select().from(agentRuns).where(eq(agentRuns.orgId, orgId));
    for (const r of allRuns) {
      const t = rows.find((x) => x.id === r.ticketId)!;
      const ev = fromStoredEvaluation(t.evaluation as StoredEvaluation);
      expect(["at_risk", "breached"]).toContain(actionableRisk(ev.metrics, h.clock.now(), FIRST_SEEN_GRACE_MS));
    }
  });

  it("a ticket crossing at_risk after connect dispatches (and alerts) as usual", async () => {
    const assist = await ticketBySource(s.assist.sourceId);
    expect(assist.risk).toBe("ok");
    h.clock.set(s.t1);
    await sweepDueTickets(h.deps);
    await h.drain();

    const after = await ticketBySource(s.assist.sourceId);
    expect(after.risk).toBe("at_risk");
    const runs = await owner.db.select().from(agentRuns).where(eq(agentRuns.ticketId, assist.id));
    expect(runs.map((r) => `${r.kind}:${r.status}`).sort()).toEqual(["draft_reply:succeeded", "triage:succeeded"]);
    expect(await notified([assist.id])).toHaveLength(1);

    // Re-evaluating the long-breached tickets later still does not dispatch: they never crossed again.
    for (const id of longBreached.slice(0, 5)) await h.queue.send("evaluate-ticket", { orgId, ticketId: id });
    await h.drain();
    expect(await owner.db.select().from(agentRuns).where(inArray(agentRuns.ticketId, longBreached))).toEqual([]);
  });
});
