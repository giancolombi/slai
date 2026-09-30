import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { zendesk } from "../src/connectors/zendesk.js";
import { toEngineEvents } from "../src/lib/events.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://acme.zendesk.com";
const AUTH = `Basic ${Buffer.from("admin@acme.com/token:tok_123").toString("base64")}`;

function client(routes: Route[]) {
  const f = fakeFetch(routes);
  const c = zendesk.create({
    credentials: { subdomain: "acme", email: "admin@acme.com", apiToken: "tok_123" },
    config: {},
    mapping: zendesk.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${BASE}/api/v2/tickets/1001.json?include=users,organizations`,
    headers: { authorization: AUTH },
    fixture: "zendesk/ticket-1001.json",
  },
  {
    method: "GET",
    url: `${BASE}/api/v2/tickets/1001/audits.json?page[size]=100&include=users`,
    headers: { authorization: AUTH },
    fixture: "zendesk/audits-1001-page1.json",
  },
  {
    method: "GET",
    url: `${BASE}/api/v2/tickets/1001/audits.json?page[after]=xyz1&page[size]=100&include=users`,
    headers: { authorization: AUTH },
    fixture: "zendesk/audits-1001-page2.json",
  },
];

describe("zendesk connector", () => {
  it("tests the connection and rejects the anonymous user", async () => {
    const ok = client([
      {
        method: "GET",
        url: `${BASE}/api/v2/users/me.json`,
        headers: { authorization: AUTH },
        json: { user: { id: 222, name: "Dana", role: "admin" } },
      },
    ]);
    expect(await ok.c.testConnection()).toEqual({ accountName: "acme.zendesk.com", accountId: "acme" });
    const anon = client([
      {
        method: "GET",
        url: `${BASE}/api/v2/users/me.json`,
        json: { user: { id: null, name: "Anonymous user", role: "end-user" } },
      },
    ]);
    expect((await rejection(anon.c.testConnection())).kind).toBe("auth");
  });

  it("lists updated tickets through the incremental cursor export, across pages", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/api/v2/incremental/tickets/cursor.json?start_time=1790553600&include=users,organizations&per_page=500`,
        headers: { authorization: AUTH },
        fixture: "zendesk/incremental-page1.json",
      },
      {
        method: "GET",
        url: `${BASE}/api/v2/incremental/tickets/cursor.json?cursor=MTU3NjYxMzUzOS4wfHw0Njd8&include=users,organizations&per_page=500`,
        fixture: "zendesk/incremental-page2.json",
      },
    ]);
    const since = new Date(1790553600 * 1000);
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => t.ref.sourceId)).toEqual(["1001"]); // deleted ticket skipped
    expect(p1.items[0]).toMatchObject({
      status: "open",
      priority: "urgent",
      requester: { email: "maya.chen@northwind.example", orgName: "Northwind Analytics" },
      assignee: { sourceId: "222", name: "Dana Whitfield" },
      ref: { displayKey: "#1001", url: "https://acme.zendesk.com/agent/tickets/1001" },
    });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // hold → on_hold; an unknown custom priority is defaulted and flagged.
    expect(p2.items[0]).toMatchObject({ status: "on_hold", priority: null, rawPriority: "p2-custom" });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "priority", raw: "p2-custom" }]);
  });

  it("builds canonical events from audits: pending, reopen, internal vs public, bot vs agent", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("1001");
    expect(f.unused()).toEqual([]);
    const summary = h.events.map((e) => {
      if (e.type === "created") return `created:${e.status}:${e.priority}`;
      if (e.type === "status_changed") return `status:${e.status}`;
      if (e.type === "priority_changed") return `priority:${e.priority}`;
      if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
      if (e.type === "assignee_changed") return `assignee:${e.assigneeSourceId}`;
      return `tags:${e.tags.join(",")}`;
    });
    expect(summary).toEqual([
      "created:new:high",
      "tags:enterprise,sso",
      "comment:requester:public",
      "comment:bot:public",
      "comment:agent:internal",
      "assignee:222",
      "comment:agent:public",
      "status:pending",
      "comment:requester:public",
      "status:open",
      "comment:agent:public",
      "status:solved",
      "comment:requester:public",
      "status:open",
      "priority:urgent",
      "tags:enterprise,sso,reopened",
    ]);
    expect(h.events[2]?.idempotencyKey).toBe("zendesk:acme:audit:70001:80001");
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["80001", "requester", true],
      ["80006", "bot", true],
      ["80008", "agent", false],
      ["80010", "agent", true],
      ["80012", "requester", true],
      ["80014", "agent", true],
      ["80016", "requester", true],
    ]);
    expect(h.comments[0]?.bodyText).toBe(
      "Since this morning about a dozen of our users get an audience mismatch error.",
    );
  });

  it("history keys are stable across fetches (webhook + poll dedupe)", async () => {
    const a = await client(historyRoutes).c.getTicketWithHistory("1001");
    const b = await client(historyRoutes).c.getTicketWithHistory("1001");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: the engine sees FR met, a breached next response after reopen, resolution running", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("1001");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-29T10:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(40 * 60_000); // the bot auto-ack did not count
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => x.state)).toEqual(["achieved", "breached"]);
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-29T09:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(220 * 60_000); // pending time paused
    expect(ev.risk).toBe("breached");
  });

  it("verifies webhook signatures (timestamp + body, HMAC-SHA256, base64)", async () => {
    const { c } = client([]);
    const secret = "whsec_test";
    const body = JSON.stringify({
      account_id: 1,
      detail: { id: "1001", status: "OPEN" },
      event: { comment: { id: "80020", is_public: true } },
      id: "evt_1",
      subject: "zen:ticket:1001",
      time: "2026-09-29T10:00:00Z",
      type: "zen:event-type:ticket.comment_added",
      zendesk_event_version: "2022-06-20",
    });
    const ts = "2026-09-29T10:00:01Z";
    const sig = createHmac("sha256", secret)
      .update(ts + body)
      .digest("base64");
    const req = (s: string) => ({
      headers: { "X-Zendesk-Webhook-Signature": s, "X-Zendesk-Webhook-Signature-Timestamp": ts },
      rawBody: body,
      url: "https://api.slai.dev/webhooks/zendesk/conn_1",
    });
    expect(await c.handleWebhook(req(sig), secret)).toEqual({ ok: true, ticketSourceIds: ["1001"] });
    expect(await c.handleWebhook(req(sig), "wrong")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook({ ...req(sig), rawBody: body.replace("1001", "1002") }, secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook(req(sig), null)).toEqual({ ok: false, reason: "bad_signature" });
    // Trigger webhook with our documented body.
    const trig = JSON.stringify({ ticket_id: "77" });
    const tsig = createHmac("sha256", secret)
      .update(ts + trig)
      .digest("base64");
    expect(await c.handleWebhook({ ...req(tsig), rawBody: trig }, secret)).toEqual({
      ok: true,
      ticketSourceIds: ["77"],
    });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { c } = client([
      { method: "GET", url: /\/api\/v2\/tickets\/1001\.json/, status: 429, responseHeaders: { "Retry-After": "93" } },
    ]);
    const err = await rejection(c.getTicketWithHistory("1001"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(93_000);
  });

  it("writes notes, replies, and updates", async () => {
    const { c, f } = client([
      {
        method: "PUT",
        url: `${BASE}/api/v2/tickets/1001.json`,
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: (b) => expect(b).toEqual({ ticket: { comment: { body: "Drafted by slai", public: false } } }),
        fixture: "zendesk/update-comment.json",
      },
      {
        method: "PUT",
        url: `${BASE}/api/v2/tickets/1001.json`,
        body: (b) => expect(b).toEqual({ ticket: { comment: { body: "Fixed!", public: true } } }),
        fixture: "zendesk/update-comment.json",
      },
      {
        method: "PUT",
        url: `${BASE}/api/v2/tickets/1001.json`,
        body: (b) => expect(b).toEqual({ ticket: { priority: "urgent", assignee_id: 222 } }),
        json: { ticket: { id: 1001 } },
      },
      {
        method: "PUT",
        url: `${BASE}/api/v2/tickets/1001/tags.json`,
        body: (b) => expect(b).toEqual({ tags: ["vip"] }),
        json: { tags: ["enterprise", "sso", "vip"] },
      },
    ]);
    expect(await c.postInternalNote("1001", "Drafted by slai")).toEqual({ commentSourceId: "80020" });
    expect(await c.postPublicReply("1001", "Fixed!")).toEqual({ commentSourceId: "80020" });
    await c.updateTicket("1001", { priority: "urgent", assigneeSourceId: "222", addTags: ["vip"] });
    expect(f.unused()).toEqual([]);
  });
});

describe("zendesk help center articles (knowledge)", () => {
  it("declares knowledge support", () => {
    expect(zendesk.supportsKnowledge).toBe(true);
  });

  it("pages through published articles as plain text, skipping drafts", async () => {
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}/api/v2/help_center/articles.json?page[size]=100`,
        headers: { authorization: AUTH },
        fixture: "zendesk/articles-page1.json",
      },
      {
        method: "GET",
        url: `${BASE}/api/v2/help_center/articles.json?page[size]=100&page[after]=xyzA1`,
        headers: { authorization: AUTH },
        fixture: "zendesk/articles-page2.json",
      },
    ]);
    const p1 = await c.listKnowledgeArticles!(null);
    expect(p1.items).toEqual([
      {
        sourceId: "360001",
        title: "Fix a SAML audience mismatch",
        url: "https://acme.zendesk.com/hc/en-us/articles/360001-Fix-SAML-audience-mismatch",
        bodyText:
          "Symptoms\n\nUsers see Invalid SAML assertion: audience mismatch.\n\n• Open your IdP settings\n• Set the audience URI to https://app.acme.example/saml\n\nFish & chips",
        locale: "en-us",
        updatedAt: new Date("2026-09-01T12:30:00Z"),
      },
    ]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listKnowledgeArticles!(p1.nextCursor);
    expect(p2.items.map((a) => [a.sourceId, a.locale, a.bodyText])).toEqual([
      ["360003", "de", "Bis zu 600 Anfragen pro Minute."],
    ]);
    expect(p2.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
  });

  it("surfaces a rate limit with the server's Retry-After", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/api/v2/help_center/articles.json?page[size]=100`,
        status: 429,
        responseHeaders: { "retry-after": "42" },
        json: { error: "TooManyRequests" },
      },
    ]);
    const err = await rejection(c.listKnowledgeArticles!(null));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(42_000);
  });
});
