/**
 * T-47b end to end: the demo help desk's saved replies (macros) are synced as
 * a `saved_replies` source, with their placeholders stripped, and one of them
 * grounds the autopilot customer's reply: retrieved, quoted, recorded as used,
 * and sent, with no help-center articles in the org at all.
 */
import { createAgentRuntime } from "@slai/agents";
import { agentActions, agentRuns, knowledgeArticles, knowledgeSources, tickets } from "@slai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { knowledgeResources, retrieveKnowledge } from "../src/knowledge.js";
import { sweepDueTickets } from "../src/sweep.js";
import {
  createConnection,
  createCustomer,
  createOrg,
  createPolicy,
  createRule,
  parkTimers,
  setupWorker,
} from "./harness.js";
import { DEMO, findScenario, type Scenario } from "./scenario.js";

const h = setupWorker({ agents: createAgentRuntime({ runtime: "local", provider: "mock" }) });
h.deps.resources = knowledgeResources(h.deps);
const { owner } = h;
let s: Scenario;
let orgId: string;
let connectionId: string;
let sourceId: string;

beforeAll(async () => {
  orgId = await createOrg(owner);
  connectionId = await createConnection(h, orgId, { config: { ...DEMO } });
  const [source] = await owner.db
    .insert(knowledgeSources)
    .values({ orgId, connectionId, kind: "saved_replies", name: "Acme Cloud macros" })
    .returning();
  sourceId = source!.id;
  await h.queue.send("sync-knowledge", { orgId, sourceId });
  await h.drain(["sync-knowledge"]);
  // A moment whose autopilot ticket the mock draft can answer from these saved replies alone.
  s = await findScenario(new Date("2026-09-29T20:00:00Z"), async (q) =>
    (await h.deps.orgDb.withOrg(orgId, (tx) => retrieveKnowledge(tx, q))).map((a) => ({
      title: a.title,
      url: a.url,
      body: a.body,
    })),
  );
});
afterAll(async () => {
  await parkTimers(owner, orgId);
});

describe("autopilot grounded in a help-desk saved reply (T-47b)", () => {
  it("syncs the demo macros as saved replies, without placeholders", async () => {
    const rows = await owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.sourceId, sourceId));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.every((r) => r.url === null && !r.bodyText.includes("{{"))).toBe(true);
    const all = await owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.orgId, orgId));
    expect(all).toHaveLength(rows.length);
  });

  it("sends the at-risk reply, quoting and recording the saved reply it relied on", async () => {
    h.clock.set(s.t0);
    await createPolicy(owner, orgId);
    const customer = await createCustomer(owner, orgId, {
      name: "Autopilot Co",
      domains: [s.autopilot.orgDomain],
      fee: 500_000,
    });
    await createRule(owner, orgId, { customerAccountId: customer, level: "autopilot" });
    await h.queue.send("sync-connection", { orgId, connectionId, full: true });
    await h.drain();
    h.clock.set(s.t1);
    await sweepDueTickets(h.deps);
    await h.drain();

    const [ticket] = await owner.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.connectionId, connectionId), eq(tickets.externalId, s.autopilot.sourceId)));
    const actions = await owner.db.select().from(agentActions).where(eq(agentActions.ticketId, ticket!.id));
    const runs = await owner.db.select().from(agentRuns).where(eq(agentRuns.ticketId, ticket!.id));
    const reply = actions.find((a) => a.kind === "public_reply")!;
    expect(reply.status).toBe("sent");
    expect(reply.blockedReason).toBeNull();

    const used = (reply.payload as { usedArticles: { id: string; title: string; url: string | null }[] })
      .usedArticles;
    expect(used).toHaveLength(1);
    const [saved] = await owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.id, used[0]!.id));
    expect(saved!.sourceId).toBe(sourceId);
    expect(used[0]).toEqual({ id: saved!.id, title: saved!.title, url: null });
    expect(reply.body).toContain(saved!.title);
    // The quoted opening is the macro's text with "Hi {{ticket.requester.first_name}}," reduced to "Hi,".
    expect(saved!.bodyText.startsWith("Hi,\n\n")).toBe(true);
    expect(reply.body).not.toMatch(/\{\{|\}\}/);

    const draftRun = runs.find((r) => r.kind === "draft_reply")!;
    expect((draftRun.output as { flags: { unsureOfFacts: boolean } }).flags.unsureOfFacts).toBe(false);
    expect((draftRun.output as { usedArticles: unknown }).usedArticles).toEqual(used);
  });
});
