/**
 * Finds, in the deterministic demo help desk, a moment T0 with two open
 * tickets from different customer orgs whose first response is still ok at
 * T0, reaches at_risk before T1, and is not answered by the scripted demo
 * agent before T1. One of them must be a ticket the mock agents would
 * auto-send (so the autopilot path is exercised end to end).
 */
import { createAgentRuntime, decideAutopilot, type TicketContext } from "@slai/agents";
import { getConnector, type TicketWithHistory } from "@slai/connectors";

export const DEMO = { seed: "e2e", ticketsPerDay: 20, historyDays: 5 } as const;
const MIN = 60_000;
/** TEST_POLICY: first response 120 minutes, warnings at 50% and 80%. */
const TARGET = 120 * MIN;
const AT_RISK = 0.8 * TARGET;
const WARNING = 0.5 * TARGET;

export interface Candidate {
  sourceId: string;
  orgDomain: string;
  createdAt: Date;
  atRiskAt: Date;
}

export interface Scenario {
  t0: Date;
  t1: Date;
  autopilot: Candidate;
  assist: Candidate;
}

export const knowledgeFor = (subject: string) => [
  { title: subject, url: null, body: `${subject}: open Settings, then follow the guided steps for this issue.` },
];

function contextAt(h: TicketWithHistory, at: Date): TicketContext {
  return {
    ticketKey: h.ticket.ref.displayKey,
    subject: h.ticket.subject,
    priority: h.ticket.priority,
    status: "new",
    customerName: null,
    thread: h.comments
      .filter((c) => c.at <= at)
      .map((c) => ({
        at: c.at.toISOString(),
        authorRole: c.authorRole,
        authorName: c.authorName,
        public: c.public,
        body: c.bodyText,
      })),
    sla: { risk: "at_risk", mostUrgent: null, metrics: ["first_response"] },
    knowledge: knowledgeFor(h.ticket.subject),
    assignees: [],
  };
}

export async function findScenario(around: Date): Promise<Scenario> {
  const def = getConnector("demo")!;
  const far = new Date(around.getTime() + 3 * 86_400_000);
  const probe = def.create({
    credentials: {},
    config: { ...DEMO, connectionId: `probe-${around.getTime()}`, now: far },
    mapping: def.defaultMapping,
    fetch: globalThis.fetch,
  });
  const since = new Date(around.getTime() - 2 * 86_400_000);
  const all: TicketWithHistory[] = [];
  let cursor: string | null = null;
  do {
    const page = await probe.listUpdatedTickets(since, cursor);
    for (const t of page.items) {
      if (t.createdAt >= since && t.createdAt <= around) all.push(await probe.getTicketWithHistory(t.ref.sourceId));
    }
    cursor = page.nextCursor;
  } while (cursor);

  const agents = createAgentRuntime({ runtime: "local", provider: "mock" });
  const firstReply = (h: TicketWithHistory) =>
    h.comments
      .filter((c) => c.public && c.authorRole === "agent")
      .map((c) => c.at.getTime())
      .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;

  // Try T0 every 5 minutes over the day before `around`.
  for (let t = around.getTime() - 86_400_000; t <= around.getTime(); t += 5 * MIN) {
    const open = all.filter((h) => {
      const c = h.ticket.createdAt.getTime();
      return c <= t && t - c < WARNING - MIN && firstReply(h) > c + AT_RISK + 10 * MIN;
    });
    if (open.length < 2) continue;
    const t1 = Math.max(...open.slice(0, 2).map((h) => h.ticket.createdAt.getTime() + AT_RISK)) + MIN;
    for (const a of open) {
      const aC = a.ticket.createdAt.getTime();
      if (!(firstReply(a) > t1 && t1 < aC + TARGET)) continue;
      for (const b of open) {
        const bC = b.ticket.createdAt.getTime();
        if (b === a || b.ticket.requester.orgSourceId === a.ticket.requester.orgSourceId) continue;
        const pairT1 = Math.max(aC, bC) + AT_RISK + MIN;
        if (!(firstReply(a) > pairT1 && firstReply(b) > pairT1 && pairT1 < Math.min(aC, bC) + TARGET)) continue;
        const ctx = contextAt(a, new Date(pairT1));
        const tri = await agents.triage(ctx);
        if (!tri.ok) continue;
        const dr = await agents.draftReply(ctx, tri.output);
        if (!dr.ok || !decideAutopilot(dr.output, { minConfidence: 0.8, triage: tri.output, ctx }).send) continue;
        const cand = (h: TicketWithHistory, c: number): Candidate => ({
          sourceId: h.ticket.ref.sourceId,
          orgDomain: h.ticket.requester.email!.split("@")[1]!,
          createdAt: new Date(c),
          atRiskAt: new Date(c + AT_RISK),
        });
        return { t0: new Date(t), t1: new Date(pairT1), autopilot: cand(a, aC), assist: cand(b, bC) };
      }
    }
  }
  throw new Error("no e2e scenario found in the demo data; adjust DEMO or TEST_POLICY");
}
