import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { helpScout } from "../src/connectors/help-scout.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { FieldMapping } from "../src/types.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://api.helpscout.net";
const AUTH = "Bearer hs_at_4f2c9e";

const tokenRoute: Route = {
  method: "POST",
  url: `${BASE}/v2/oauth2/token`,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  fixture: "help_scout/token.json",
};

function client(routes: Route[], mapping: FieldMapping = helpScout.defaultMapping) {
  const f = fakeFetch([tokenRoute, ...routes]);
  // The token request is form-encoded (URLSearchParams), which the fake fetch
  // doesn't parse; capture it here.
  const tokenBodies: string[] = [];
  const spy = ((input: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof URLSearchParams) tokenBodies.push(init.body.toString());
    return f.fetch(input, init);
  }) as typeof fetch;
  const c = helpScout.create({
    credentials: { clientId: "app_7Kq2", clientSecret: "sec_Zx91" },
    config: {},
    mapping,
    fetch: spy,
  });
  return { c, f, tokenBodies };
}

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${BASE}/v2/conversations/7001`,
    headers: { authorization: AUTH },
    fixture: "help_scout/conversation-7001.json",
  },
  {
    method: "GET",
    url: `${BASE}/v2/conversations/7001/threads?page=1`,
    headers: { authorization: AUTH },
    fixture: "help_scout/threads-7001-page1.json",
  },
  {
    method: "GET",
    url: `${BASE}/v2/conversations/7001/threads?page=2`,
    headers: { authorization: AUTH },
    fixture: "help_scout/threads-7001-page2.json",
  },
];

describe("help scout connector", () => {
  it("exchanges client credentials for a token, caches it, and tests the connection", async () => {
    const { c, f, tokenBodies } = client([
      {
        method: "GET",
        url: `${BASE}/v2/users/me`,
        headers: { authorization: AUTH },
        fixture: "help_scout/users-me.json",
        repeat: true,
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "Help Scout company 44120", accountId: "44120" });
    await c.testConnection();
    // One token exchange for both calls: the token is cached in the client.
    expect(tokenBodies).toEqual(["grant_type=client_credentials&client_id=app_7Kq2&client_secret=sec_Zx91"]);
    expect(f.calls.filter((x) => x.url.endsWith("/oauth2/token"))).toHaveLength(1);
    expect(f.unused()).toEqual([]);
  });

  it("rejects bad app credentials as auth", async () => {
    const f = fakeFetch([
      { method: "POST", url: `${BASE}/v2/oauth2/token`, status: 401, json: { error: "invalid_client" } },
    ]);
    const c = helpScout.create({
      credentials: { clientId: "nope", clientSecret: "nope" },
      config: {},
      mapping: helpScout.defaultMapping,
      fetch: f.fetch,
    });
    expect((await rejection(c.testConnection())).kind).toBe("auth");
  });

  it("refreshes the token once when the API says it expired", async () => {
    const { c, f } = client([
      { method: "GET", url: `${BASE}/v2/users/me`, fixture: "help_scout/users-me.json" },
      { method: "GET", url: `${BASE}/v2/users/me`, status: 401, json: { error: "expired" } },
      {
        method: "POST",
        url: `${BASE}/v2/oauth2/token`,
        json: { access_token: "hs_at_fresh", token_type: "bearer", expires_in: 172800 },
      },
      {
        method: "GET",
        url: `${BASE}/v2/users/me`,
        headers: { authorization: "Bearer hs_at_fresh" },
        fixture: "help_scout/users-me.json",
      },
    ]);
    await c.testConnection();
    expect((await c.testConnection()).accountId).toBe("44120");
    expect(f.unused()).toEqual([]);
  });

  it("lists modified conversations page by page and flags unmapped priority tags", async () => {
    const url = (page: number) =>
      `${BASE}/v2/conversations?status=all&modifiedSince=2026-09-28T00:00:00Z&sortField=modifiedAt&sortOrder=asc&page=${page}`;
    const { c } = client([
      { method: "GET", url: url(1), headers: { authorization: AUTH }, fixture: "help_scout/conversations-page1.json" },
      { method: "GET", url: url(2), headers: { authorization: AUTH }, fixture: "help_scout/conversations-page2.json" },
    ]);
    const since = new Date("2026-09-28T00:00:00.000Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.rawStatus, t.priority])).toEqual([
      ["#1042", "open", "active", "high"],
      ["#1043", "solved", "closed", null],
    ]);
    expect(p1.items[0]).toMatchObject({
      ref: { sourceId: "7001", url: "https://secure.helpscout.net/conversation/7001/1042" },
      rawPriority: "priority-high",
      requester: { sourceId: "5501", email: "priya.raman@lumenfield.example", name: "Priya Raman" },
      assignee: { sourceId: "802", name: "Tess Moreno" },
      groupSourceId: "3100",
      tags: ["priority-high", "billing"],
      channel: "email",
      mappingIssues: [],
    });
    expect(p1.items[1]?.assignee).toBeNull();
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // An unknown `priority-*` tag defaults to null and is flagged.
    expect(p2.items[0]).toMatchObject({ status: "pending", priority: null, rawPriority: "priority-p2" });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "priority", raw: "priority-p2" }]);
  });

  it("builds canonical events from threads: pending, reopen, internal vs public, workflow bot, assignee", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("7001");
    expect(f.unused()).toEqual([]);
    const summary = h.events.map((e) => {
      if (e.type === "created") return `created:${e.status}:${e.priority}`;
      if (e.type === "status_changed") return `status:${e.status}:${e.rawStatus}`;
      if (e.type === "priority_changed") return `priority:${e.priority}`;
      if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
      if (e.type === "assignee_changed") return `assignee:${e.assigneeSourceId}`;
      return `tags:${e.tags.join(",")}`;
    });
    // Help Scout has no native priority and threads don't record tag changes,
    // so there are no priority_changed events: the created event carries the
    // current priority tag (priority-high). The draft thread is ignored.
    expect(summary).toEqual([
      "created:open:high",
      "comment:requester:public",
      "comment:bot:public",
      "comment:agent:internal",
      "assignee:801",
      "comment:agent:public",
      "status:pending:pending",
      "comment:requester:public",
      "status:open:active",
      "comment:agent:public",
      "status:solved:closed",
      "comment:requester:public",
      "status:open:active",
      "assignee:802",
    ]);
    expect(h.events[1]?.idempotencyKey).toBe("help_scout:api.helpscout.net:thread:90001");
    expect(h.events[6]?.idempotencyKey).toBe("help_scout:api.helpscout.net:thread:90005:status");
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["90001", "requester", true],
      ["90002", "bot", true],
      ["90003", "agent", false],
      ["90005", "agent", true],
      ["90006", "requester", true],
      ["90007", "agent", true],
      ["90008", "requester", true],
    ]);
    expect(h.comments[3]).toMatchObject({ authorName: "Owen Hart", authorSourceId: "801" });
    expect(h.comments[3]?.bodyText).toBe("Hi Priya,\ncould you tell us roughly how many invoices March has?");
    expect(h.ticket).toMatchObject({ status: "open", priority: "high", assignee: { sourceId: "802" } });
  });

  it("history keys are stable across fetches (webhook + poll dedupe)", async () => {
    const a = await client(historyRoutes).c.getTicketWithHistory("7001");
    const b = await client(historyRoutes).c.getTicketWithHistory("7001");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met despite the auto-ack, NR breached after reopen, resolution paused while pending", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("7001");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T17:00:00Z"));
    // high: FR 60 min, NR 120 min, resolution 1440 min.
    const fr = metric(ev, "first_response");
    expect(fr).toMatchObject({ state: "achieved", elapsedMs: 40 * 60_000 }); // the 09:02 workflow reply didn't count
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => [x.state, x.elapsedMs])).toEqual([
      ["achieved", 50 * 60_000], // 11:40 → 12:30
      ["breached", 180 * 60_000], // reopened 14:00, unanswered at 17:00
    ]);
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-28T16:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    // 09:00–09:40 + 11:40–12:30 + 14:00–17:00; pending (09:40–11:40) and solved time excluded.
    expect(res.elapsedMs).toBe(270 * 60_000);
    expect(res.dueAt?.toISOString()).toBe("2026-09-29T12:30:00.000Z");
    expect(ev.risk).toBe("breached");
  });

  it("verifies webhook signatures (X-HelpScout-Signature, HMAC-SHA1 base64 of the raw body)", async () => {
    const { c } = client([]);
    const secret = "hs_whsec";
    const body = JSON.stringify({ id: 7001, number: 1042, status: "active", subject: "Invoices export times out" });
    const sig = createHmac("sha1", secret).update(body).digest("base64");
    const req = (s?: string, event = "convo.customer.reply.created") => ({
      headers: { "X-HelpScout-Signature": s, "X-HelpScout-Event": event },
      rawBody: body,
      url: "https://api.slai.dev/webhooks/help_scout/conn_1",
    });
    expect(await c.handleWebhook(req(sig), secret)).toEqual({ ok: true, ticketSourceIds: ["7001"] });
    expect(await c.handleWebhook(req(sig), "wrong")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sig), null)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook({ ...req(sig), rawBody: body.replace("7001", "7002") }, secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // Signed but not a conversation event: nothing to sync.
    expect(await c.handleWebhook(req(sig, "customer.updated"), secret)).toEqual({ ok: true, ticketSourceIds: [] });
    const bad = "not json";
    const badSig = createHmac("sha1", secret).update(bad).digest("base64");
    expect(await c.handleWebhook({ ...req(badSig), rawBody: bad }, secret)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await c.handleWebhook({ headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/x" }, "secret"),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { c } = client([
      { method: "GET", url: `${BASE}/v2/conversations/7001`, status: 429, responseHeaders: { "Retry-After": "12" } },
    ]);
    const err = await rejection(c.getTicketWithHistory("7001"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(12_000);
  });

  it("writes notes, replies, assignment, and priority/tags (tags are merged, not replaced)", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/v2/conversations/7001/notes`,
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: (b) => expect(b).toEqual({ text: "<p>Drafted by slai</p>" }),
        status: 201,
        responseHeaders: { "Resource-ID": "90011" },
      },
      { method: "GET", url: `${BASE}/v2/conversations/7001`, fixture: "help_scout/conversation-7001.json" },
      {
        method: "POST",
        url: `${BASE}/v2/conversations/7001/reply`,
        body: (b) => expect(b).toEqual({ customer: { id: 5501 }, text: "<p>Fixed on our side.<br>Thanks!</p>" }),
        status: 201,
        responseHeaders: { "Resource-ID": "90012" },
      },
      {
        method: "PATCH",
        url: `${BASE}/v2/conversations/7001`,
        body: (b) => expect(b).toEqual({ op: "replace", path: "/assignTo", value: 801 }),
        status: 204,
      },
      { method: "GET", url: `${BASE}/v2/conversations/7001`, fixture: "help_scout/conversation-7001.json" },
      {
        method: "PUT",
        url: `${BASE}/v2/conversations/7001/tags`,
        // priority-high is swapped for priority-urgent; billing is kept; vip added.
        body: (b) => expect(b).toEqual({ tags: ["billing", "priority-urgent", "vip"] }),
        status: 204,
      },
    ]);
    expect(await c.postInternalNote("7001", "Drafted by slai")).toEqual({ commentSourceId: "90011" });
    expect(await c.postPublicReply("7001", "Fixed on our side.\nThanks!")).toEqual({ commentSourceId: "90012" });
    await c.updateTicket("7001", { priority: "urgent", assigneeSourceId: "801", addTags: ["vip"] });
    expect(f.unused()).toEqual([]);
  });

  it("refuses a priority with no mapped tag", async () => {
    const mapping: FieldMapping = {
      status: helpScout.defaultMapping.status,
      priority: { "priority-high": "high", "priority-normal": "normal" },
    };
    const { c, f } = client([], mapping);
    expect((await rejection(c.updateTicket("7001", { priority: "urgent" }))).kind).toBe("invalid");
    expect(f.calls).toEqual([]);
  });
});

describe("help scout saved replies (knowledge)", () => {
  const replyRoutes: Route[] = [
    {
      method: "GET",
      url: `${BASE}/v2/mailboxes?page=1`,
      headers: { authorization: AUTH },
      fixture: "help_scout/mailboxes-page1.json",
    },
    {
      method: "GET",
      url: `${BASE}/v2/mailboxes?page=2`,
      headers: { authorization: AUTH },
      fixture: "help_scout/mailboxes-page2.json",
    },
    { method: "GET", url: `${BASE}/v2/mailboxes/301/saved-replies`, fixture: "help_scout/saved-replies-301.json" },
    {
      method: "GET",
      url: `${BASE}/v2/mailboxes/301/saved-replies/234567`,
      fixture: "help_scout/saved-reply-301-234567.json",
    },
    {
      method: "GET",
      url: `${BASE}/v2/mailboxes/301/saved-replies/234568`,
      fixture: "help_scout/saved-reply-301-234568.json",
    },
    { method: "GET", url: `${BASE}/v2/mailboxes/302/saved-replies`, fixture: "help_scout/saved-replies-302.json" },
    {
      method: "GET",
      url: `${BASE}/v2/mailboxes/302/saved-replies/234567`,
      fixture: "help_scout/saved-reply-302-234567.json",
    },
  ];

  it("declares saved-reply support", () => {
    expect(helpScout.supportsSavedReplies).toBe(true);
  });

  it("walks every mailbox's saved replies, one page per mailbox, placeholders resolved", async () => {
    const { c, f } = client(replyRoutes);
    const p1 = await c.listSavedReplies!(null);
    expect(p1.items).toEqual([
      {
        sourceId: "301:234567",
        title: "Resetting two-factor authentication",
        url: null,
        bodyText: "Hi there,\n\nAn admin can reset your second factor from Settings > Members.\n\nThanks,",
        locale: null,
        updatedAt: new Date(0),
      },
    ]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listSavedReplies!(p1.nextCursor);
    // The same reply id in another mailbox is scoped by mailbox, so it does not collide.
    expect(p2.items.map((r) => [r.sourceId, r.bodyText])).toEqual([
      ["302:234567", "We refund annual plans within 14 days of purchase."],
    ]);
    expect(p2.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
    expect((await rejection(c.listSavedReplies!("not-a-cursor"))).kind).toBe("invalid");
  });

  it("reports a token without access to saved replies as unsupported", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/v2/mailboxes?page=1`,
        json: { _embedded: { mailboxes: [{ id: 302 }] }, page: { number: 1, totalPages: 1 } },
      },
      // A 403 on a cached token is retried once with a fresh token (auth plumbing) before it surfaces.
      tokenRoute,
      {
        method: "GET",
        url: `${BASE}/v2/mailboxes/302/saved-replies`,
        status: 403,
        json: { message: "Forbidden" },
        repeat: true,
      },
    ]);
    const err = await rejection(c.listSavedReplies!(null));
    expect(err.kind).toBe("unsupported");
    expect(err.message).toMatch(/Help Scout saved replies/);
  });
});
