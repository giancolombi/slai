import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { front } from "../src/connectors/front.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { CanonicalEvent, FieldMapping } from "../src/types.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://api2.frontapp.com";
const AUTH = "Bearer tok_front";

function client(
  routes: Route[],
  credentials: { apiToken: string; teammateId?: string } = { apiToken: "tok_front" },
  mapping: FieldMapping = front.defaultMapping,
) {
  const f = fakeFetch(routes);
  const c = front.create({ credentials, config: {}, mapping, fetch: f.fetch });
  return { c, f };
}

const summarize = (events: CanonicalEvent[]) =>
  events.map((e) => {
    if (e.type === "created") return `created:${e.status}:${e.priority}`;
    if (e.type === "status_changed") return `status:${e.status}:${e.rawStatus}`;
    if (e.type === "priority_changed") return `priority:${e.priority}`;
    if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
    if (e.type === "assignee_changed") return `assignee:${e.assigneeSourceId}`;
    return `tags:${e.tags.join(",")}`;
  });

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${BASE}/conversations/cnv_7h2k4`,
    headers: { authorization: AUTH },
    fixture: "front/conversation-cnv_7h2k4.json",
  },
  {
    method: "GET",
    url: `${BASE}/conversations/cnv_7h2k4/events?limit=100`,
    headers: { authorization: AUTH },
    fixture: "front/events-cnv_7h2k4-page1.json",
  },
  {
    method: "GET",
    url: `${BASE}/conversations/cnv_7h2k4/events?limit=100&page_token=pg2_7h2k4`,
    headers: { authorization: AUTH },
    fixture: "front/events-cnv_7h2k4-page2.json",
  },
  {
    method: "GET",
    url: `${BASE}/conversations/cnv_7h2k4/messages?limit=100&sort_by=created_at&sort_order=asc`,
    headers: { authorization: AUTH },
    fixture: "front/messages-cnv_7h2k4.json",
  },
  {
    method: "GET",
    url: `${BASE}/conversations/cnv_7h2k4/comments`,
    headers: { authorization: AUTH },
    fixture: "front/comments-cnv_7h2k4.json",
  },
];

describe("front connector", () => {
  it("tests the connection via /me with a bearer token", async () => {
    const { c } = client([
      { method: "GET", url: `${BASE}/me`, headers: { authorization: AUTH }, fixture: "front/me.json" },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "Acme Support Co.", accountId: "cmp_acme1" });
    const bad = client([{ method: "GET", url: `${BASE}/me`, status: 401, json: { _error: { status: 401 } } }]);
    expect((await rejection(bad.c.testConnection())).kind).toBe("auth");
  });

  it("lists updated conversations from the event feed, across pages", async () => {
    const since = new Date(1790553600 * 1000);
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}/events?q[after]=1790553600&sort_by=created_at&sort_order=asc&limit=15`,
        headers: { authorization: AUTH },
        fixture: "front/events-page1.json",
      },
      {
        method: "GET",
        url: `${BASE}/events?limit=15&page_token=evtpg_2&q[after]=1790553600&sort_by=created_at&sort_order=asc`,
        headers: { authorization: AUTH },
        fixture: "front/events-page2.json",
      },
    ]);
    const p1 = await c.listUpdatedTickets(since, null);
    // Deduped per conversation, keeping the latest state seen on the page.
    expect(p1.items.map((t) => t.ref.sourceId)).toEqual(["cnv_9p3m1", "cnv_7h2k4"]);
    expect(p1.items[0]).toMatchObject({
      status: "pending",
      rawStatus: "waiting",
      priority: "normal",
      rawPriority: "priority: normal",
      ref: { displayKey: "TICKET-418", url: "https://app.frontapp.com/open/cnv_9p3m1" },
      requester: { sourceId: "crd_leo02", email: "leo.park@globex.example", name: "Leo Park" },
      mappingIssues: [],
    });
    expect(p1.items[1]).toMatchObject({
      status: "solved",
      rawStatus: "archived",
      priority: "high",
      assignee: { sourceId: "tea_dana", name: "Dana Whitfield" },
      tags: ["priority: high"],
      updatedAt: new Date("2026-09-28T11:31:00Z"),
    });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // An unknown priority tag is defaulted and flagged; a phone handle is no email.
    expect(p2.items[0]).toMatchObject({
      status: "solved",
      priority: null,
      rawPriority: "priority: p2-custom",
      assignee: null,
      requester: { sourceId: null, email: null },
    });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "priority", raw: "priority: p2-custom" }]);
    expect(f.unused()).toEqual([]);
  });

  it("refuses to follow a pagination link off Front's hosts", async () => {
    const { c } = client([
      {
        method: "GET",
        url: /\/events\?/,
        json: { _pagination: { next: "https://evil.example/events?page_token=x" }, _results: [] },
      },
    ]);
    expect((await rejection(c.listUpdatedTickets(new Date(1790553600 * 1000), null))).kind).toBe("upstream");
  });

  it("builds canonical events: snooze → pending, reopen, internal vs public, bot vs agent, tag priority", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("cnv_7h2k4");
    expect(f.unused()).toEqual([]);
    expect(summarize(h.events)).toEqual([
      "created:open:null",
      "comment:requester:public",
      "tags:priority: high",
      "priority:high",
      "comment:bot:public", // outbound by a rule teammate
      "comment:agent:internal",
      "assignee:tea_dana", // assigned→open is a no-op status change, dropped
      "comment:agent:public",
      "status:pending:snoozed", // archive followed by a reminder = snooze
      "status:open:assigned",
      "comment:requester:public",
      "comment:agent:public",
      "status:solved:archived",
      "comment:requester:public",
      "status:open:assigned",
      "tags:priority: high,urgent",
      "priority:urgent",
      "tags:urgent", // untagging the lower priority keeps urgent: no priority event
    ]);
    expect(h.events[1]?.idempotencyKey).toBe("front:message:msg_1");
    expect(h.events[2]?.idempotencyKey).toBe("front:event:evt_100");
    expect(h.events[3]?.idempotencyKey).toBe("front:event:evt_100:priority");
    expect(h.events[8]?.idempotencyKey).toBe("front:event:evt_103:status");
    expect(h.events[2]?.at.toISOString()).toBe("2026-09-28T08:00:05.250Z");
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["msg_1", "requester", true],
      ["msg_2", "bot", true],
      ["com_1", "agent", false],
      ["msg_3", "agent", true],
      ["msg_4", "requester", true],
      ["msg_5", "agent", true],
      ["msg_6", "requester", true],
    ]);
    expect(h.comments[0]).toMatchObject({
      authorName: "Maya Chen",
      authorSourceId: "maya.chen@northwind.example",
      bodyText: "Since this morning about a dozen of our users get an audience mismatch error.",
    });
    expect(h.comments[6]?.bodyText).toBe("It is failing again for new users."); // HTML fallback
    expect(h.ticket).toMatchObject({
      status: "open",
      rawStatus: "assigned",
      priority: "urgent",
      rawPriority: "urgent",
    });
  });

  it("history keys are stable across fetches (webhook + poll dedupe)", async () => {
    const a = await client(historyRoutes).c.getTicketWithHistory("cnv_7h2k4");
    const b = await client(historyRoutes).c.getTicketWithHistory("cnv_7h2k4");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met despite the bot ack, a breached next response after reopen, resolution running", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("cnv_7h2k4");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T15:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(40 * 60_000); // 08:00 → 08:40; the 08:01 rule auto-reply did not count
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => x.state)).toEqual(["achieved", "breached"]);
    expect(nr.cycles[0]?.elapsedMs).toBe(30 * 60_000);
    // 13:00 requester reply, urgent (60 min) target → due 14:00, 120 min elapsed at 15:00.
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-28T14:00:00.000Z");
    expect(nr.cycles[1]?.elapsedMs).toBe(120 * 60_000);
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    // 08:00–08:41 (41) + snoozed paused + 10:41–11:31 (50) + archived + 13:00–15:00 (120)
    expect(res.elapsedMs).toBe(211 * 60_000);
    expect(res.dueAt?.toISOString()).toBe("2026-09-28T19:29:00.000Z"); // urgent 480 min
    expect(ev.risk).toBe("breached");
  });

  it("verifies application webhooks (timestamp:body, HMAC-SHA256, base64, max age)", async () => {
    const { c } = client([]);
    const secret = "app_signing_key";
    const body = JSON.stringify({
      type: "inbound_received",
      authorization: { id: "cmp_acme1" },
      payload: {
        id: "evt_400",
        type: "inbound",
        emitted_at: 1790600400,
        conversation: { id: "cnv_7h2k4", status: "unassigned" },
      },
    });
    const ts = String(Date.now());
    const sign = (t: string, b: string, s = secret) => createHmac("sha256", s).update(`${t}:${b}`).digest("base64");
    const req = (sig: string | undefined, t: string | undefined = ts, b = body) => ({
      headers: { "X-Front-Signature": sig, "X-Front-Request-Timestamp": t },
      rawBody: b,
      url: "https://api.slai.dev/webhooks/front/conn_1",
    });
    expect(await c.handleWebhook(req(sign(ts, body)), secret)).toEqual({ ok: true, ticketSourceIds: ["cnv_7h2k4"] });
    expect(await c.handleWebhook(req(sign(ts, body)), "wrong")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sign(ts, body)), null)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sign(ts, body), ts, body.replace("7h2k4", "0000")), secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const stale = String(Date.now() - 6 * 60_000);
    expect(await c.handleWebhook(req(sign(stale, body), stale), secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook(req(sign(ts, "not json"), ts, "not json"), secret)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // Validation ping without a conversation: accepted, nothing to sync.
    const sync = JSON.stringify({ type: "sync", authorization: { id: "cmp_acme1" }, payload: {} });
    expect(await c.handleWebhook(req(sign(ts, sync), ts, sync), secret)).toEqual({ ok: true, ticketSourceIds: [] });
    // The registry's unsigned probe.
    expect(
      await c.handleWebhook(
        { headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/webhooks/x" },
        "secret",
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("verifies rule webhooks (body, HMAC-SHA1 with the API secret, base64)", async () => {
    const { c } = client([]);
    const secret = "api_secret_123";
    const body = JSON.stringify({
      _links: { self: `${BASE}/events/evt_401` },
      id: "evt_401",
      type: "tag",
      emitted_at: 1790600700,
      conversation: { id: "cnv_7h2k4", status: "assigned" },
    });
    const sig = createHmac("sha1", secret).update(body).digest("base64");
    const req = (s: string, b = body) => ({ headers: { "x-front-signature": s }, rawBody: b, url: "https://x" });
    expect(await c.handleWebhook(req(sig), secret)).toEqual({ ok: true, ticketSourceIds: ["cnv_7h2k4"] });
    expect(await c.handleWebhook(req(sig), "wrong")).toEqual({ ok: false, reason: "bad_signature" });
    // A SHA256 signature does not pass the SHA1 scheme.
    const sha256 = createHmac("sha256", secret).update(body).digest("base64");
    expect(await c.handleWebhook(req(sha256), secret)).toEqual({ ok: false, reason: "bad_signature" });
    const custom = JSON.stringify({ conversation_id: "cnv_9p3m1" });
    const csig = createHmac("sha1", secret).update(custom).digest("base64");
    expect(await c.handleWebhook(req(csig, custom), secret)).toEqual({ ok: true, ticketSourceIds: ["cnv_9p3m1"] });
    const junk = JSON.stringify({ ticket_id: "1" });
    const jsig = createHmac("sha1", secret).update(junk).digest("base64");
    expect(await c.handleWebhook(req(jsig, junk), secret)).toEqual({ ok: false, reason: "malformed" });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { c } = client([
      { method: "GET", url: /\/conversations\/cnv_7h2k4$/, status: 429, responseHeaders: { "Retry-After": "12" } },
    ]);
    const err = await rejection(c.getTicketWithHistory("cnv_7h2k4"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(12_000);
  });

  it("writes notes, replies (without archiving), assignee and tag-based priority", async () => {
    const { c, f } = client(
      [
        {
          method: "POST",
          url: `${BASE}/conversations/cnv_7h2k4/comments`,
          headers: { authorization: AUTH, "content-type": "application/json" },
          body: (b) => expect(b).toEqual({ body: "Drafted by slai", author_id: "tea_dana" }),
          status: 201,
          fixture: "front/comment-created.json",
        },
        {
          method: "POST",
          url: `${BASE}/conversations/cnv_7h2k4/messages`,
          body: (b) =>
            expect(b).toEqual({
              body: "<p>Fixed!</p><p>Thanks &amp; bye</p>",
              author_id: "tea_dana",
              options: { archive: false },
            }),
          status: 202,
          json: { status: "accepted", message_uid: "3b1q41d8" },
        },
        {
          method: "GET",
          url: `${BASE}/conversations/cnv_7h2k4`,
          fixture: "front/conversation-cnv_7h2k4.json",
        },
        {
          method: "PUT",
          url: `${BASE}/conversations/cnv_7h2k4/assignee`,
          body: (b) => expect(b).toEqual({ assignee_id: "tea_sam" }),
          status: 204,
        },
        {
          method: "DELETE",
          url: `${BASE}/conversations/cnv_7h2k4/tags`,
          body: (b) => expect(b).toEqual({ tag_ids: ["tag_urg"] }), // the old priority tag
          status: 204,
        },
        { method: "GET", url: `${BASE}/tags?limit=100`, fixture: "front/tags-page1.json" },
        {
          method: "POST",
          url: `${BASE}/tags`,
          body: (b) => expect(b).toEqual({ name: "vip" }),
          status: 201,
          json: { id: "tag_vip", name: "vip" },
        },
        {
          method: "POST",
          url: `${BASE}/conversations/cnv_7h2k4/tags`,
          body: (b) => expect(b).toEqual({ tag_ids: ["tag_vip", "tag_ph"] }),
          status: 204,
        },
      ],
      { apiToken: "tok_front", teammateId: "tea_dana" },
    );
    expect(await c.postInternalNote("cnv_7h2k4", "Drafted by slai")).toEqual({ commentSourceId: "com_77" });
    expect(await c.postPublicReply("cnv_7h2k4", "Fixed!\n\nThanks & bye")).toEqual({ commentSourceId: null });
    await c.updateTicket("cnv_7h2k4", { priority: "high", assigneeSourceId: "tea_sam", addTags: ["vip"] });
    expect(f.unused()).toEqual([]);
  });

  it("rejects a priority with no mapped tag as invalid, before any request", async () => {
    const mapping: FieldMapping = { ...front.defaultMapping, priority: { "priority: high": "high" } };
    const { c, f } = client([], { apiToken: "tok_front" }, mapping);
    expect((await rejection(c.updateTicket("cnv_7h2k4", { priority: "low" }))).kind).toBe("invalid");
    expect(f.calls).toEqual([]);
  });
});

describe("front message templates (saved replies)", () => {
  it("declares saved-reply support", () => {
    expect(front.supportsSavedReplies).toBe(true);
  });

  it("pages through message templates as plain text without variables, skipping empty ones", async () => {
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}/message_templates?limit=100`,
        headers: { authorization: AUTH },
        fixture: "front/message-templates-page1.json",
      },
      {
        method: "GET",
        url: `${BASE}/message_templates?limit=100&page_token=tpl_p2`,
        headers: { authorization: AUTH },
        fixture: "front/message-templates-page2.json",
      },
    ]);
    const p1 = await c.listSavedReplies!(null);
    expect(p1.items).toEqual([
      {
        sourceId: "rsp_16yc",
        title: "Webhook retries",
        url: null,
        bodyText: "Hi,\n\nWebhook deliveries are retried for 24 hours & you can replay them.",
        locale: null,
        updatedAt: new Date(0),
      },
    ]);
    const p2 = await c.listSavedReplies!(p1.nextCursor);
    expect(p2.items).toEqual([expect.objectContaining({ sourceId: "rsp_16ye", updatedAt: new Date(1758000000250) })]);
    expect(p2.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
  });

  it("refuses a pagination link to another host, and reports a 403 as unsupported", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/message_templates?limit=100`,
        json: { _pagination: { next: "https://evil.example/message_templates" }, _results: [] },
      },
      { method: "GET", url: `${BASE}/message_templates?limit=100`, status: 403, json: { _error: {} } },
    ]);
    expect((await rejection(c.listSavedReplies!(null))).kind).toBe("upstream");
    const err = await rejection(c.listSavedReplies!(null));
    expect(err.kind).toBe("unsupported");
    expect(err.message).toMatch(/Front message templates/);
  });
});
