/**
 * Live SLA conformance against a real Zammad (T-24, TR-14). Opt-in: skipped
 * unless ZAMMAD_LIVE_URL and ZAMMAD_LIVE_TOKEN are set, e.g. against the
 * `zammad` compose profile:
 *
 *   docker compose --profile zammad up -d
 *   ZAMMAD_LIVE_URL=http://localhost:8080 ZAMMAD_LIVE_TOKEN=… \
 *     pnpm --filter @slai/connectors exec vitest run test/live
 *
 * The token needs admin (calendars, SLAs, ticket delete) and ticket.agent.
 *
 * It sets up a 24x7 UTC calendar and an SLA for "3 high" tickets that mirror
 * `calendarPolicy()` (first response 60 min, solution 1440 min), then drives a
 * ticket through: customer opens → agent replies → pending → reopen. After each
 * step it compares our canonical events + `evaluateTicket` with Zammad's own
 * escalation timestamps (first_response_escalation_at, first_response_at,
 * close_escalation_at).
 *
 * Tolerances: Zammad computes escalations at minute granularity, and a Zammad
 * calendar day ends at 23:59, so instants are compared within 90 s.
 *
 * Zammad's update-time SLA (response vs. update mode) is not compared: its
 * API parameters differ across versions, and first response + solution are the
 * contract-critical pair.
 */
import { evaluateTicket } from "@slai/sla-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zammad } from "../../src/connectors/zammad.js";
import { toEngineEvents } from "../../src/lib/events.js";
import type { ConnectorClient } from "../../src/types.js";
import { calendarPolicy, metric } from "../helpers/policy.js";

const URL_ = process.env.ZAMMAD_LIVE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.ZAMMAD_LIVE_TOKEN;
/** How long the ticket stays pending; long enough to be visible above the tolerance. */
const PAUSE_MS = Number(process.env.ZAMMAD_LIVE_PAUSE_MS ?? 150_000);
const TOLERANCE_MS = 90_000;
const TAG = "slai-conformance";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: {
      Authorization: `Token token=${TOKEN}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface ZTicket {
  id: number;
  state: string;
  created_at: string;
  first_response_at: string | null;
  first_response_escalation_at: string | null;
  close_escalation_at: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function near(ours: Date | null | undefined, theirs: string | null | undefined, what: string) {
  expect(ours, `${what}: ours`).toBeTruthy();
  expect(theirs, `${what}: Zammad`).toBeTruthy();
  const diff = Math.abs((ours as Date).getTime() - Date.parse(theirs as string));
  expect(diff, `${what}: ours ${(ours as Date).toISOString()} vs Zammad ${theirs}`).toBeLessThanOrEqual(TOLERANCE_MS);
}

describe.skipIf(!URL_ || !TOKEN)("zammad live conformance", () => {
  let c: ConnectorClient;
  let ticketId: number | null = null;

  beforeAll(async () => {
    c = zammad.create({
      credentials: { baseUrl: URL_ as string, apiToken: TOKEN as string },
      config: {},
      mapping: zammad.defaultMapping,
      fetch: globalThis.fetch,
    });

    const day = { active: true, timeframes: [["00:00", "23:59"]] };
    const calendars = await api<{ id: number; name: string }[]>("GET", "/api/v1/calendars");
    const calendar =
      calendars.find((x) => x.name === `${TAG} 24x7`) ??
      (await api<{ id: number }>("POST", "/api/v1/calendars", {
        name: `${TAG} 24x7`,
        timezone: "UTC",
        business_hours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
        default: false,
        ical_url: "",
        public_holidays: {},
      }));
    const priorities = await api<{ id: number; name: string }[]>("GET", "/api/v1/ticket_priorities");
    const high = priorities.find((p) => p.name === "3 high");
    if (!high) throw new Error('Zammad has no "3 high" priority');
    const slas = await api<{ id: number; name: string }[]>("GET", "/api/v1/slas");
    const sla = {
      name: `${TAG} high`,
      calendar_id: calendar.id,
      first_response_time: 60,
      solution_time: 1440,
      condition: {
        "ticket.priority_id": { operator: "is", value: [String(high.id)] },
        "ticket.title": { operator: "contains", value: TAG },
      },
    };
    const existing = slas.find((x) => x.name === sla.name);
    if (existing) await api("PUT", `/api/v1/slas/${existing.id}`, sla);
    else await api("POST", "/api/v1/slas", sla);
  }, 60_000);

  afterAll(async () => {
    if (ticketId !== null) await api("DELETE", `/api/v1/tickets/${ticketId}`).catch(() => undefined);
  });

  const zTicket = () => api<ZTicket>("GET", `/api/v1/tickets/${ticketId}`);
  const evaluate = async () => {
    const h = await c.getTicketWithHistory(String(ticketId));
    return { h, ev: evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date()) };
  };

  it(
    "agrees with Zammad's escalation timestamps through reply, pending and reopen",
    async () => {
      const created = await api<ZTicket>("POST", "/api/v1/tickets", {
        title: `${TAG} ${new Date().toISOString()}`,
        group: "Users",
        customer_id: `guess:${TAG}+${Date.now()}@example.com`,
        priority: "3 high",
        article: {
          subject: "Our SSO login fails",
          body: "Since this morning our users get an audience mismatch error.",
          type: "web",
          sender: "Customer",
          internal: false,
        },
      });
      ticketId = created.id;

      // 1. Open, unanswered: first-response and solution deadlines agree.
      let z = await zTicket();
      let { h, ev } = await evaluate();
      expect(h.events[0]).toMatchObject({ type: "created", priority: "high" });
      expect(metric(ev, "first_response").state).toBe("running");
      near(metric(ev, "first_response").dueAt, z.first_response_escalation_at, "first response due");
      near(metric(ev, "resolution").dueAt, z.close_escalation_at, "resolution due");

      // 2. Agent reply (through our write-back): first response achieved at the same instant.
      await c.postPublicReply(String(ticketId), "We are looking into the SSO configuration now.");
      z = await zTicket();
      ({ h, ev } = await evaluate());
      const fr = metric(ev, "first_response");
      expect(fr.state).toBe("achieved");
      near(fr.cycles[0]?.stoppedAt, z.first_response_at, "first response at");
      expect(h.comments.filter((x) => x.authorRole === "agent" && x.public)).toHaveLength(1);

      // 3. Pending: our resolution clock pauses; Zammad suspends escalation.
      const pendingTime = new Date(Date.now() + 24 * 3_600_000).toISOString();
      await api("PUT", `/api/v1/tickets/${ticketId}`, { state: "pending reminder", pending_time: pendingTime });
      ({ ev } = await evaluate());
      expect(ev.status).toBe("pending");
      expect(metric(ev, "resolution").state).toBe("paused");
      await sleep(PAUSE_MS);

      // 4. Reopen: the resolution deadline moves by the pending time, on both sides.
      await api("PUT", `/api/v1/tickets/${ticketId}`, { state: "open" });
      z = await zTicket();
      ({ h, ev } = await evaluate());
      const summary = h.events
        .filter((e) => e.type === "status_changed" || e.type === "comment")
        .map((e) => (e.type === "status_changed" ? `status:${e.status}` : `comment:${e.author}`));
      expect(summary).toEqual(["comment:requester", "comment:agent", "status:pending", "status:open"]);
      const res = metric(ev, "resolution");
      expect(res.state).toBe("running");
      // The pending time is not counted: due = created + 24 h + time spent pending.
      expect(res.dueAt?.getTime()).toBeGreaterThanOrEqual(
        Date.parse(created.created_at) + 1440 * 60_000 + PAUSE_MS - TOLERANCE_MS,
      );
      near(res.dueAt, z.close_escalation_at, "resolution due after reopen");
    },
    PAUSE_MS + 120_000,
  );
});
