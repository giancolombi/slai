import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { gorgias } from "../src/connectors/gorgias.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { FieldMapping } from "../src/types.js";
import { fakeFetch, fixture, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://tidewater.gorgias.com";
const AUTH = `Basic ${Buffer.from("ops@tidewater-support.example:gg_key").toString("base64")}`;

function client(routes: Route[], mapping: FieldMapping = gorgias.defaultMapping) {
  const f = fakeFetch(routes);
  const c = gorgias.create({
    credentials: { domain: " Tidewater ", email: "ops@tidewater-support.example", apiKey: "gg_key" },
    config: {},
    mapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const messagesUrl = (cursor?: string) =>
  `${BASE}/api/messages?ticket_id=7301&order_by=created_datetime:asc&limit=100${cursor ? `&cursor=${cursor}` : ""}`;

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${BASE}/api/tickets/7301`,
    headers: { authorization: AUTH },
    fixture: "gorgias/ticket-7301.json",
  },
  { method: "GET", url: messagesUrl(), headers: { authorization: AUTH }, fixture: "gorgias/messages-7301-p1.json" },
  { method: "GET", url: messagesUrl("bXNnLWN1cnNvci0y"), fixture: "gorgias/messages-7301-p2.json" },
  {
    method: "GET",
    url: `${BASE}/api/events?object_type=Ticket&object_id=7301&order_by=created_datetime:asc&limit=100`,
    headers: { authorization: AUTH },
    fixture: "gorgias/events-7301.json",
  },
];

describe("gorgias connector", () => {
  it("tests the connection with basic auth (email:api key)", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/api/account`,
        headers: { authorization: AUTH },
        json: { domain: "tidewater", status: { status: "active" }, created_datetime: "2024-02-01T10:00:00" },
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "tidewater.gorgias.com", accountId: "tidewater" });
  });

  it("pages tickets newest-first, maps snoozed to pending, stops at `since`, flags unmapped priorities", async () => {
    const url = (cursor?: string) =>
      `${BASE}/api/tickets?order_by=updated_datetime:desc&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    // A customer mapping that leaves "critical" unmapped.
    const mapping: FieldMapping = {
      status: gorgias.defaultMapping.status,
      priority: { low: "low", normal: "normal", high: "high" },
    };
    const { c, f } = client(
      [
        { method: "GET", url: url(), headers: { authorization: AUTH }, fixture: "gorgias/tickets-page1.json" },
        { method: "GET", url: url("dGt0LWN1cnNvci0y"), fixture: "gorgias/tickets-page2.json" },
      ],
      mapping,
    );
    const since = new Date("2026-09-28T00:00:00Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.rawStatus, t.priority])).toEqual([
      ["#7302", "pending", "snoozed", "normal"],
      ["#7301", "open", "open", "high"],
    ]);
    // Naive Gorgias datetimes are UTC.
    expect(p1.items[0]?.updatedAt.toISOString()).toBe("2026-09-28T16:00:00.000Z");
    expect(p1.items[0]?.assignee).toBeNull();
    expect(p1.items[1]).toMatchObject({
      requester: { sourceId: "5501", email: "priya.natarajan@larkspur-goods.example", name: "Priya Natarajan" },
      assignee: { sourceId: "88", name: "Marco Villa" },
      groupSourceId: "4",
      tags: ["vip"],
      channel: "email",
      ref: { url: `${BASE}/app/ticket/7301` },
    });
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    // #7150 was updated before `since`: filtered out, and the scan stops even though Gorgias has more pages.
    expect(p2.items.map((t) => t.ref.sourceId)).toEqual(["7296"]);
    expect(p2.nextCursor).toBeNull();
    expect(p2.items[0]).toMatchObject({
      status: "solved",
      rawStatus: "closed",
      priority: null,
      rawPriority: "critical",
    });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "priority", raw: "critical" }]);
    expect(f.unused()).toEqual([]);
    expect((await rejection(c.listUpdatedTickets(since, "garbage!"))).kind).toBe("invalid");
  });

  it("builds canonical events from messages + events: snooze pause, reopen, internal vs public, rule bot", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("7301");
    expect(f.unused()).toEqual([]);
    const summary = h.events.map((e) => {
      if (e.type === "created") return `created:${e.status}:${e.priority}`;
      if (e.type === "status_changed") return `status:${e.status}:${e.rawStatus}`;
      if (e.type === "priority_changed") return `priority:${e.priority}`;
      if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
      if (e.type === "assignee_changed") return `assignee:${e.assigneeSourceId}`;
      return `tags:${e.tags.join(",")}`;
    });
    // The ticket-closed logged with the snooze (same context) is dropped: a snooze is not a solve.
    expect(summary).toEqual([
      "created:open:normal",
      "comment:requester:public",
      "comment:bot:public",
      "assignee:88",
      "comment:agent:internal",
      "comment:agent:public",
      "status:pending:snoozed",
      "status:open:open",
      "comment:requester:public",
      "priority:high",
      "tags:damaged-item,vip",
    ]);
    expect(h.ticket).toMatchObject({
      status: "open",
      priority: "high",
      tags: ["damaged-item", "vip"],
      ref: { displayKey: "#7301" },
    });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public, x.authorName])).toEqual([
      ["910001", "requester", true, "Priya Natarajan"],
      ["910002", "bot", true, "Tidewater Support"],
      ["910003", "agent", false, "Marco Villa"],
      ["910004", "agent", true, "Marco Villa"],
      ["910005", "requester", true, "Priya Natarajan"],
    ]);
    expect(h.comments[2]?.bodyText).toBe("Checked the warehouse photos — packaging was fine. Carrier damage.");
    expect(h.comments[0]?.at.toISOString()).toBe("2026-09-28T09:00:00.000Z");
    expect(h.events.find((e) => e.type === "comment")?.idempotencyKey).toBe("gorgias:tidewater:message:910001");
    expect(h.events.find((e) => e.type === "status_changed")?.idempotencyKey).toBe("gorgias:tidewater:event:660005");
  });

  it("end to end: FR met by the agent (not the rule), next response breached after the reply, resolution paused while snoozed", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("7301");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T18:00:00Z"));
    // 09:00 → 10:30 agent reply; the 09:05 rule auto-reply is a bot and doesn't count.
    expect(metric(ev, "first_response")).toMatchObject({ state: "achieved", elapsedMs: 90 * 60_000 });
    const nr = metric(ev, "next_response");
    expect(nr.state).toBe("breached"); // high: 120 min; running since the 12:00 reply
    expect(nr.elapsedMs).toBe(360 * 60_000);
    expect(nr.cycles[0]?.breachAt?.toISOString()).toBe("2026-09-28T14:00:00.000Z");
    const res = metric(ev, "resolution");
    // 09:00–10:31 (91) + snoozed 10:31–12:00 paused + 12:00–18:00 (360) = 451 min of 1440.
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(451 * 60_000);
    expect(res.dueAt?.toISOString()).toBe("2026-09-29T10:29:00.000Z");
  });

  it("verifies the shared-secret header on HTTP-integration deliveries", async () => {
    const { c } = client([]);
    const body = JSON.stringify({ ticket_id: "7301" });
    const req = (s?: string) => ({
      headers: { "X-Slai-Webhook-Secret": s, "Content-Type": "application/json" },
      rawBody: body,
      url: "https://api.slai.dev/webhooks/gorgias/conn_1",
    });
    expect(await c.handleWebhook(req("gg_hook_secret"), "gg_hook_secret")).toEqual({
      ok: true,
      ticketSourceIds: ["7301"],
    });
    expect(
      await c.handleWebhook({ ...req("gg_hook_secret"), rawBody: '{"ticket_id":7302}' }, "gg_hook_secret"),
    ).toEqual({ ok: true, ticketSourceIds: ["7302"] });
    expect(await c.handleWebhook(req("gg_hook_secret"), "other")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined), "gg_hook_secret")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req("gg_hook_secret"), null)).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      await c.handleWebhook({ headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://x.example" }, "secret"),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook({ ...req("gg_hook_secret"), rawBody: "not json" }, "gg_hook_secret")).toEqual({
      ok: false,
      reason: "malformed",
    });
    // An unrendered template variable is not a ticket id.
    expect(
      await c.handleWebhook({ ...req("gg_hook_secret"), rawBody: '{"ticket_id":"{{ticket.id}}"}' }, "gg_hook_secret"),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("maps 429 to rate_limited", async () => {
    const { c } = client([
      { method: "GET", url: /tickets\/7301/, status: 429, responseHeaders: { "Retry-After": "7" } },
    ]);
    const err = await rejection(c.getTicketWithHistory("7301"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(7000);
  });

  it("writes internal notes, email replies, and updates", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/api/tickets/7301/messages`,
        headers: { authorization: AUTH },
        body: (b) =>
          expect(b).toEqual({
            channel: "internal-note",
            via: "api",
            from_agent: true,
            public: false,
            sender: { email: "ops@tidewater-support.example" },
            body_text: "Drafted by slai",
            body_html: "<p>Drafted by slai</p>",
          }),
        json: { id: 910006 },
      },
      {
        method: "GET",
        url: `${BASE}/api/messages?ticket_id=7301&order_by=created_datetime:desc&limit=30`,
        json: { data: [...fixtureData("messages-7301-p2.json")].reverse(), meta: { next_cursor: null } },
      },
      {
        method: "POST",
        url: `${BASE}/api/tickets/7301/messages`,
        body: (b) =>
          expect(b).toEqual({
            channel: "email",
            via: "api",
            from_agent: true,
            public: true,
            sender: { email: "ops@tidewater-support.example" },
            receiver: { email: "priya.natarajan@larkspur-goods.example" },
            source: {
              type: "email",
              from: { address: "help@tidewater-support.example", name: "Tidewater Support" },
              to: [{ address: "priya.natarajan@larkspur-goods.example", name: "Priya Natarajan" }],
            },
            subject: "Re: Order #LG-20418 arrived damaged",
            body_text: "A replacement ships today.",
            body_html: "<p>A replacement ships today.</p>",
          }),
        json: { id: 910007 },
      },
      {
        method: "PUT",
        url: `${BASE}/api/tickets/7301`,
        body: (b) => expect(b).toEqual({ priority: "critical", assignee_user: { id: 88 } }),
        status: 202,
        json: { id: 7301 },
      },
      {
        method: "POST",
        url: `${BASE}/api/tickets/7301/tags`,
        body: (b) => expect(b).toEqual({ names: ["vip", "damaged-item"] }),
        status: 201,
      },
    ]);
    expect(await c.postInternalNote("7301", "Drafted by slai")).toEqual({ commentSourceId: "910006" });
    expect(await c.postPublicReply("7301", "A replacement ships today.")).toEqual({ commentSourceId: "910007" });
    await c.updateTicket("7301", { priority: "urgent", assigneeSourceId: "88", addTags: ["vip", "damaged-item"] });
    expect(f.unused()).toEqual([]);
  });

  it("refuses a reply with no inbound email and a priority with no mapped raw value", async () => {
    const mapping: FieldMapping = { status: gorgias.defaultMapping.status, priority: { normal: "normal" } };
    const { c } = client(
      [
        {
          method: "GET",
          url: `${BASE}/api/messages?ticket_id=7302&order_by=created_datetime:desc&limit=30`,
          json: {
            data: [
              { id: 1, channel: "chat", from_agent: false, public: true, created_datetime: "2026-09-28T14:10:00" },
            ],
            meta: { next_cursor: null },
          },
        },
      ],
      mapping,
    );
    expect((await rejection(c.postPublicReply("7302", "hi"))).kind).toBe("invalid");
    expect((await rejection(c.updateTicket("7302", { priority: "urgent" }))).kind).toBe("invalid");
  });
});

// biome-ignore lint/suspicious/noExplicitAny: fixtures are free-form JSON
function fixtureData(name: string): any[] {
  return fixture(`gorgias/${name}`).data;
}
