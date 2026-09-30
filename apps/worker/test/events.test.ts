/**
 * T-56: the web app refreshes from `slai_events`, so every state change it shows
 * must be announced: an action's send (approved → sending → sent), an agent
 * run starting, and a replay starting.
 */
import { randomUUID } from "node:crypto";
import { agentActions, agentRuns, EVENTS_CHANNEL, parseEvent, type RealtimeEvent, replays, tickets } from "@slai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeAction, runAgent } from "../src/agents.js";
import { runReplay } from "../src/replay.js";
import { createConnection, createOrg, createPolicy, createRule, parkTimers, setupWorker } from "./harness.js";

const h = setupWorker();
const { owner } = h;
let orgId: string;
let connectionId: string;
let ticket: typeof tickets.$inferSelect;
const heard: RealtimeEvent[] = [];
let unlisten: (() => Promise<void>) | null = null;

/** Waits until `pred` holds for the events heard so far (NOTIFY is delivered asynchronously). */
async function until(pred: (events: RealtimeEvent[]) => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!pred(heard) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return pred(heard);
}
const mine = () => heard.filter((e) => e.orgId === orgId);

beforeAll(async () => {
  orgId = await createOrg(owner);
  await createPolicy(owner, orgId);
  await createRule(owner, orgId, { customerAccountId: null, level: "assist" });
  connectionId = await createConnection(h, orgId, { config: { seed: "events", ticketsPerDay: 5, historyDays: 2 } });
  await h.queue.send("sync-connection", { orgId, connectionId, full: true });
  await h.drain();
  await parkTimers(owner, orgId);
  const rows = await owner.db.select().from(tickets).where(eq(tickets.orgId, orgId));
  ticket = rows.find((t) => t.status === "open" || t.status === "new") ?? rows[0]!;
  const sub = await owner.client.listen(EVENTS_CHANNEL, (payload) => {
    const e = parseEvent(payload);
    if (e) heard.push(e);
  });
  unlisten = sub.unlisten;
});

afterAll(async () => {
  await unlisten?.();
});

describe("realtime events", () => {
  it("announces each status change of an approved action's send", async () => {
    heard.length = 0;
    const [a] = await owner.db
      .insert(agentActions)
      .values({
        orgId,
        ticketId: ticket.id,
        kind: "public_reply",
        status: "approved",
        body: `Hello ${randomUUID()}`,
        decidedAt: h.clock.now(),
      })
      .returning();
    await executeAction(h.deps, { orgId, actionId: a!.id });
    const [row] = await owner.db.select().from(agentActions).where(eq(agentActions.id, a!.id));
    expect(row!.status).toBe("sent");
    const updates = () => mine().filter((e) => e.type === "action.updated" && e.id === a!.id);
    // sending, then sent
    expect(await until(() => updates().length >= 2)).toBe(true);
    expect(mine().some((e) => e.type === "ticket.updated" && e.id === ticket.id)).toBe(true);
  });

  it("announces an agent run as it starts, before any action it proposes", async () => {
    heard.length = 0;
    const [run] = await owner.db
      .insert(agentRuns)
      .values({ orgId, kind: "draft_reply", status: "queued", ticketId: ticket.id, requestedBy: null })
      .returning();
    await runAgent(h.deps, { orgId, runId: run!.id });
    expect(await until(() => mine().some((e) => e.type === "action.created"))).toBe(true);
    const first = mine()[0];
    expect(first).toMatchObject({ type: "ticket.updated", id: ticket.id });
  });

  it("announces a replay as soon as it starts running", async () => {
    heard.length = 0;
    const [r] = await owner.db.insert(replays).values({ orgId, connectionId, days: 2, status: "queued" }).returning();
    await runReplay(h.deps, { orgId, replayId: r!.id });
    const progress = () => mine().filter((e) => e.type === "replay.progress" && e.id === r!.id);
    // running, the scan total, then the finished result
    expect(await until(() => progress().length >= 3)).toBe(true);
  });
});
