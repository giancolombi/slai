import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { FRESHDESK_MAX_PAGE, freshdesk } from "../src/connectors/freshdesk.js";
import { toEngineEvents } from "../src/lib/events.js";
import { encodeCursor } from "../src/lib/paginate.js";
import { fakeFetch, fixture, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://acme.freshdesk.com";
const AUTH = `Basic ${Buffer.from("fd_key:X").toString("base64")}`;
const MIN = 60_000;

function client(routes: Route[]) {
  const f = fakeFetch(routes);
  const c = freshdesk.create({
    credentials: { domain: "acme", apiKey: "fd_key" },
    config: {},
    mapping: freshdesk.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const listUrl = (since: string, page: number) =>
  `${BASE}/api/v2/tickets?updated_since=${encodeURIComponent(since)}&order_by=updated_at&order_type=asc&per_page=100&page=${page}&include=requester,stats`;

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${BASE}/api/v2/tickets/2001?include=requester,stats,company`,
    headers: { authorization: AUTH },
    fixture: "freshdesk/ticket-2001.json",
  },
  {
    method: "GET",
    url: `${BASE}/api/v2/tickets/2001/conversations?per_page=100&page=1`,
    headers: { authorization: AUTH },
    fixture: "freshdesk/conversations-2001-page1.json",
    responseHeaders: { link: `<${BASE}/api/v2/tickets/2001/conversations?per_page=100&page=2>; rel="next"` },
  },
  {
    method: "GET",
    url: `${BASE}/api/v2/tickets/2001/conversations?per_page=100&page=2`,
    headers: { authorization: AUTH },
    fixture: "freshdesk/conversations-2001-page2.json",
  },
];

describe("freshdesk connector", () => {
  it("tests the connection", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/api/v2/agents/me`,
        headers: { authorization: AUTH },
        json: { id: 8000001, available: true, contact: { name: "Dana", email: "dana@acme.com" } },
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "acme.freshdesk.com", accountId: "acme" });
  });

  it("lists updated tickets following the Link header", async () => {
    const since = "2026-09-28T00:00:00.000Z";
    const { c } = client([
      {
        method: "GET",
        url: listUrl(since, 1),
        headers: { authorization: AUTH },
        fixture: "freshdesk/list-page1.json",
        responseHeaders: { link: `<${listUrl(since, 2)}>; rel="next"` },
      },
      { method: "GET", url: listUrl(since, 2), fixture: "freshdesk/list-page2.json" },
    ]);
    const p1 = await c.listUpdatedTickets(new Date(since), null);
    expect(p1.items[0]).toMatchObject({
      ref: { sourceId: "2001", displayKey: "#2001", url: "https://acme.freshdesk.com/a/tickets/2001" },
      status: "pending",
      rawStatus: "3",
      priority: "high",
      channel: "email",
      requester: { email: "liam.okafor@bluepeak.example", orgSourceId: "9000001" },
      assignee: { sourceId: "8000001" },
    });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(new Date(since), p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // Unknown custom status 12 → safe default open, flagged.
    expect(p2.items[0]).toMatchObject({ status: "open", rawStatus: "12", priority: "low" });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "status", raw: "12" }]);
  });

  it("re-anchors `since` after Freshdesk's 300-page cap", async () => {
    const since = "2026-09-28T00:00:00.000Z";
    const { c } = client([
      {
        method: "GET",
        url: listUrl(since, FRESHDESK_MAX_PAGE),
        fixture: "freshdesk/list-page1.json",
        responseHeaders: { link: `<${listUrl(since, FRESHDESK_MAX_PAGE + 1)}>; rel="next"` },
      },
      { method: "GET", url: listUrl("2026-09-29T08:30:00.000Z", 1), json: [] },
    ]);
    const p = await c.listUpdatedTickets(new Date(since), encodeCursor({ since, page: FRESHDESK_MAX_PAGE }));
    const next = await c.listUpdatedTickets(new Date(since), p.nextCursor);
    expect(next).toEqual({ items: [], nextCursor: null });
  });

  it("maps conversations and synthesizes status from stats: pending, reopen, internal vs public", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("2001");
    expect(f.unused()).toEqual([]);
    const summary = h.events.map((e) => {
      if (e.type === "created") return `created:${e.status}:${e.priority}`;
      if (e.type === "status_changed") return `status:${e.status}`;
      if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
      if (e.type === "tags_changed") return `tags:${e.tags.join(",")}`;
      return e.type;
    });
    expect(summary).toEqual([
      "created:open:high",
      "tags:api,enterprise",
      "comment:requester:public",
      "comment:agent:internal",
      "comment:agent:public",
      "comment:requester:public",
      "comment:agent:public",
      "status:solved",
      "comment:requester:public",
      "status:open",
      "comment:agent:public",
      "status:pending",
    ]);
    expect(h.events.find((e) => e.type === "status_changed")?.idempotencyKey).toBe(
      "freshdesk:acme:ticket:2001:stats:resolved_at:2026-09-28T12:05:00.000Z",
    );
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["2001:description", "requester", true],
      ["3001", "agent", false],
      ["3002", "agent", true],
      ["3003", "requester", true],
      ["3004", "agent", true],
      ["3005", "requester", true],
      ["3006", "agent", true],
    ]);
    expect(h.comments[4]?.bodyText).toBe("We deployed a fix. Please retry the failed batches."); // HTML fallback
    expect(h.ticket.requester.orgName).toBe("Bluepeak Logistics");
  });

  it("history keys are stable across fetches", async () => {
    const a = await client(historyRoutes).c.getTicketWithHistory("2001");
    const b = await client(historyRoutes).c.getTicketWithHistory("2001");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met, reopen resumes resolution, pending pauses it", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("2001");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-29T10:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(30 * MIN); // the internal note at 09:15 did not count
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => [x.state, x.elapsedMs])).toEqual([
      ["achieved", 60 * MIN],
      ["achieved", 30 * MIN],
    ]);
    const res = metric(ev, "resolution");
    expect(res.state).toBe("paused");
    expect(res.elapsedMs).toBe(215 * MIN); // 185 before solve + 30 after reopen
    expect(ev.risk).toBe("ok");
  });

  it("verifies the shared-secret webhook token (header or query)", async () => {
    const { c } = client([]);
    const body = JSON.stringify({ freshdesk_webhook: { ticket_id: "2001" } });
    const url = "https://api.slai.dev/webhooks/freshdesk/conn_1";
    expect(
      await c.handleWebhook({ headers: { "X-Slai-Webhook-Token": "s3cret" }, rawBody: body, url }, "s3cret"),
    ).toEqual({
      ok: true,
      ticketSourceIds: ["2001"],
    });
    expect(await c.handleWebhook({ headers: {}, rawBody: body, url: `${url}?token=s3cret` }, "s3cret")).toEqual({
      ok: true,
      ticketSourceIds: ["2001"],
    });
    expect(
      await c.handleWebhook({ headers: { "X-Slai-Webhook-Token": "nope" }, rawBody: body, url }, "s3cret"),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook({ headers: {}, rawBody: body, url }, "s3cret")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook({ headers: { "X-Slai-Webhook-Token": "s3cret" }, rawBody: body, url }, null)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      await c.handleWebhook({ headers: { "X-Slai-Webhook-Token": "s3cret" }, rawBody: "{}", url }, "s3cret"),
    ).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { c } = client([
      { method: "GET", url: /\/api\/v2\/tickets\/2001\?/, status: 429, responseHeaders: { "Retry-After": "41" } },
    ]);
    const err = await rejection(c.getTicketWithHistory("2001"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(41_000);
  });

  it("writes notes, replies, and updates (merging tags)", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/api/v2/tickets/2001/notes`,
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: (b) => expect(b).toEqual({ body: "<p>Drafted by slai</p>", private: true }),
        json: { id: 3010, body: "<p>Drafted by slai</p>", private: true, incoming: false, ticket_id: 2001 },
      },
      {
        method: "POST",
        url: `${BASE}/api/v2/tickets/2001/reply`,
        body: (b) => expect(b).toEqual({ body: "<p>Fixed &amp; deployed.<br>Thanks</p>" }),
        json: { id: 3011, body: "<p>Fixed</p>", ticket_id: 2001 },
      },
      { method: "GET", url: `${BASE}/api/v2/tickets/2001`, json: fixture("freshdesk/ticket-2001.json") },
      {
        method: "PUT",
        url: `${BASE}/api/v2/tickets/2001`,
        body: (b) => expect(b).toEqual({ priority: 4, responder_id: 8000002, tags: ["api", "enterprise", "vip"] }),
        json: { id: 2001 },
      },
    ]);
    expect(await c.postInternalNote("2001", "Drafted by slai")).toEqual({ commentSourceId: "3010" });
    expect(await c.postPublicReply("2001", "Fixed & deployed.\nThanks")).toEqual({ commentSourceId: "3011" });
    await c.updateTicket("2001", { priority: "urgent", assigneeSourceId: "8000002", addTags: ["vip", "api"] });
    expect(f.unused()).toEqual([]);
  });
});
