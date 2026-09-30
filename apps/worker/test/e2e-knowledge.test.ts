/**
 * T-47 end to end: the demo help desk's help center is synced into
 * knowledge_articles, retrieval feeds the draft, and the autopilot
 * customer's at-risk ticket gets a reply *sent* that quotes and links a
 * synced article. The same ticket, when the draft cites a URL that is not
 * in the thread or the knowledge, is held by the guardrail instead.
 */
import { type AgentRuntime, createAgentRuntime } from "@slai/agents";
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

const EVIL_URL = "https://evil.example/fix";
const mock = createAgentRuntime({ runtime: "local", provider: "mock" });
let tamper = false;
/** The mock agents, except that a tampered draft also cites a URL nobody gave it. */
const agents: AgentRuntime = {
  extractContract: (docs, bounds) => mock.extractContract(docs, bounds),
  triage: (ctx, bounds) => mock.triage(ctx, bounds),
  async draftReply(ctx, triage, bounds) {
    const r = await mock.draftReply(ctx, triage, bounds);
    if (r.ok && tamper) r.output.body = `${r.output.body}\n\nA faster fix is described at ${EVIL_URL}`;
    return r;
  },
};

const h = setupWorker({ agents });
h.deps.resources = knowledgeResources(h.deps);
const { owner } = h;
let s: Scenario;
const orgs: string[] = [];

/** An org with the demo help desk, its synced help center, and an autopilot rule for the scenario's customer. */
async function setupOrg() {
  const orgId = await createOrg(owner);
  orgs.push(orgId);
  const connectionId = await createConnection(h, orgId, { config: { ...DEMO } });
  const [source] = await owner.db
    .insert(knowledgeSources)
    .values({ orgId, connectionId, kind: "helpdesk_articles", name: "Acme Cloud Help Center" })
    .returning();
  await h.queue.send("sync-knowledge", { orgId, sourceId: source!.id });
  await h.drain(["sync-knowledge"]);
  return { orgId, connectionId, sourceId: source!.id };
}

async function runScenario(org: { orgId: string; connectionId: string }) {
  h.clock.set(s.t0);
  await createPolicy(owner, org.orgId);
  const customer = await createCustomer(owner, org.orgId, {
    name: "Autopilot Co",
    domains: [s.autopilot.orgDomain],
    fee: 500_000,
  });
  await createRule(owner, org.orgId, { customerAccountId: customer, level: "autopilot" });
  await h.queue.send("sync-connection", { orgId: org.orgId, connectionId: org.connectionId, full: true });
  await h.drain();
  h.clock.set(s.t1);
  await sweepDueTickets(h.deps);
  await h.drain();
  const [ticket] = await owner.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.connectionId, org.connectionId), eq(tickets.externalId, s.autopilot.sourceId)));
  const actions = await owner.db.select().from(agentActions).where(eq(agentActions.ticketId, ticket!.id));
  const runs = await owner.db.select().from(agentRuns).where(eq(agentRuns.ticketId, ticket!.id));
  return { ticket: ticket!, reply: actions.find((a) => a.kind === "public_reply")!, actions, runs };
}

let first: Awaited<ReturnType<typeof setupOrg>>;

beforeAll(async () => {
  first = await setupOrg();
  // Pick the scenario with the knowledge retrieval the worker really uses.
  s = await findScenario(new Date("2026-09-29T20:00:00Z"), async (q) =>
    (await h.deps.orgDb.withOrg(first.orgId, (tx) => retrieveKnowledge(tx, q))).map((a) => ({
      title: a.title,
      url: a.url,
      body: a.body,
    })),
  );
});
afterAll(async () => {
  for (const o of orgs) await parkTimers(owner, o);
});

describe("autopilot with synced knowledge (T-47)", () => {
  it("syncs the demo help center", async () => {
    const rows = await owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.sourceId, first.sourceId));
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });

  it("sends the autopilot customer's at-risk reply, grounded in a synced article", async () => {
    const { ticket, reply, actions, runs } = await runScenario(first);
    expect(ticket.customerAccountId).not.toBeNull();

    expect(reply.status).toBe("sent");
    expect(reply.blockedReason).toBeNull();
    expect(reply.externalRef).toMatch(/-w\d+$/);
    expect(actions.some((a) => a.kind === "internal_note")).toBe(false);

    // The reply quotes and links an article the worker retrieved, and records it.
    const used = (reply.payload as { usedArticles: { id: string; title: string; url: string }[] }).usedArticles;
    expect(used).toHaveLength(1);
    const [article] = await owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.id, used[0]!.id));
    expect(article!.orgId).toBe(first.orgId);
    expect(used[0]!.url).toBe(article!.url);
    expect(reply.body).toContain(article!.url!);
    expect(reply.body).toContain(article!.title);
    const draftRun = runs.find((r) => r.kind === "draft_reply")!;
    expect(draftRun.status).toBe("succeeded");
    expect((draftRun.output as { usedArticles: unknown }).usedArticles).toEqual(used);
    expect((draftRun.output as { flags: { unsureOfFacts: boolean } }).flags.unsureOfFacts).toBe(false);
    expect(reply.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("still holds the reply when the draft cites a URL that is not in the knowledge", async () => {
    await parkTimers(owner, first.orgId);
    const second = await setupOrg();
    tamper = true;
    try {
      const { reply, actions } = await runScenario(second);
      expect(reply.status).toBe("proposed");
      expect(reply.body).toContain(EVIL_URL);
      expect(reply.blockedReason).toMatch(
        /URL that isn't in the ticket or your knowledge: https:\/\/evil\.example\/fix/,
      );
      // Assist-style fallback: a human reviews it; the review note went to the help desk.
      expect(actions.find((a) => a.kind === "internal_note")?.status).toBe("sent");
    } finally {
      tamper = false;
    }
  });
});
