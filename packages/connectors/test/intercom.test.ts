import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { intercom } from "../src/connectors/intercom.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { CanonicalEvent } from "../src/types.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://api.intercom.io";
const HEADERS = { authorization: "Bearer tok_ic", "intercom-version": "2.16" };

function client(routes: Route[], credentials: { accessToken: string; adminId?: string } = { accessToken: "tok_ic" }) {
  const f = fakeFetch(routes);
  const c = intercom.create({ credentials, config: {}, mapping: intercom.defaultMapping, fetch: f.fetch });
  return { c, f };
}

const convRoute: Route = {
  method: "GET",
  url: `${BASE}/conversations/555?display_as=plaintext`,
  headers: HEADERS,
  fixture: "intercom/conversation-555.json",
};

const summarize = (events: CanonicalEvent[]) =>
  events.map((e) => {
    if (e.type === "created") return `created:${e.status}:${e.priority}`;
    if (e.type === "status_changed") return `status:${e.status}`;
    if (e.type === "priority_changed") return `priority:${e.priority}`;
    if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
    if (e.type === "assignee_changed") return `assignee:${e.assigneeSourceId}`;
    return `tags:${e.tags.join(",")}`;
  });

describe("intercom connector", () => {
  it("tests the connection via /me", async () => {
    const { c } = client([{ method: "GET", url: `${BASE}/me`, headers: HEADERS, fixture: "intercom/me.json" }]);
    expect(await c.testConnection()).toEqual({ accountName: "Acme Support", accountId: "abc123de" });
  });

  it("uses the regional base URL", async () => {
    const f = fakeFetch([{ method: "GET", url: "https://api.eu.intercom.io/me", fixture: "intercom/me.json" }]);
    const c = intercom.create({
      credentials: { accessToken: "tok_ic" },
      config: { region: "eu" },
      mapping: intercom.defaultMapping,
      fetch: f.fetch,
    });
    await c.testConnection();
    expect(f.unused()).toEqual([]);
  });

  it("searches updated conversations with starting_after pagination", async () => {
    const since = new Date(1790467200 * 1000);
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/conversations/search`,
        headers: { ...HEADERS, "content-type": "application/json" },
        body: (b) =>
          expect(b).toEqual({
            query: { field: "updated_at", operator: ">", value: 1790467199 },
            pagination: { per_page: 150 },
          }),
        fixture: "intercom/search-page1.json",
      },
      {
        method: "POST",
        url: `${BASE}/conversations/search`,
        headers: HEADERS,
        body: (b) => expect(b.pagination).toEqual({ per_page: 150, starting_after: "WzE3OTA1ODc4MDAwMDAsNTU2LDJd" }),
        fixture: "intercom/search-page2.json",
      },
    ]);
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.sourceId, t.status, t.priority])).toEqual([
      ["555", "open", "high"],
      ["556", "pending", null], // snoozed → pending, priority none → null
    ]);
    expect(p1.items[0]?.requester).toMatchObject({ email: "liam@bluepeak.example", name: "Liam Okafor" });
    expect(p1.items[1]?.subject).toBe("Invoice question");
    expect(p1.items[0]?.mappingIssues).toEqual([]);
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // The ticket's state category wins over the conversation state.
    expect(p2.items[0]).toMatchObject({ status: "pending", rawStatus: "waiting_on_customer", priority: "normal" });
    expect(f.unused()).toEqual([]);
  });

  it("maps parts: bot vs admin, note vs reply, assign-and-reply, snooze/unsnooze, reopen", async () => {
    const { c } = client([convRoute]);
    const h = await c.getTicketWithHistory("555");
    expect(summarize(h.events)).toEqual([
      "created:new:high",
      "comment:requester:public",
      "comment:bot:public",
      "comment:agent:internal",
      "comment:agent:public",
      "assignee:991",
      "status:pending",
      "comment:requester:public",
      "status:open",
      "comment:agent:public",
      "status:solved",
      "comment:requester:public",
      "status:open",
    ]);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["403918330", "requester", true],
      ["7001", "bot", true],
      ["7002", "agent", false],
      ["7003", "agent", true],
      ["7005", "requester", true],
      ["7007", "agent", true],
      ["7009", "requester", true],
    ]);
    expect(h.comments[0]?.bodyText).toBe("Webhooks for order.updated are arriving 30-45 minutes late.");
    expect(h.events[1]?.idempotencyKey).toBe("intercom:conversation:555:source");
    expect(h.events[4]?.idempotencyKey).toBe("intercom:conversation:555:part:7003");
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.ticket).toMatchObject({
      status: "open",
      assignee: { sourceId: "991" },
      tags: ["api"],
      groupSourceId: "5017691",
    });
  });

  it("history keys are stable across fetches", async () => {
    const a = await client([convRoute]).c.getTicketWithHistory("555");
    const b = await client([convRoute]).c.getTicketWithHistory("555");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met by the admin (not the bot), snooze pauses, reopen restarts next response", async () => {
    const h = await client([convRoute]).c.getTicketWithHistory("555");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-29T09:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(30 * 60_000);
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => [x.state, x.elapsedMs / 60_000])).toEqual([
      ["achieved", 5],
      ["running", 60],
    ]);
    expect(nr.risk).toBe("warning");
    expect(nr.dueAt?.toISOString()).toBe("2026-09-29T10:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(165 * 60_000); // 45 + 60 + 60; snoozed time paused
    expect(ev.risk).toBe("warning");
  });

  it("verifies X-Hub-Signature (sha1 hex of the raw body)", async () => {
    const { c } = client([]);
    const secret = "client_secret_1";
    const body = JSON.stringify({
      type: "notification_event",
      app_id: "abc123de",
      id: "notif_1",
      topic: "conversation.user.replied",
      created_at: 1790668800,
      delivery_attempts: 1,
      first_sent_at: 1790668800,
      data: { type: "notification_event_data", item: { type: "conversation", id: "555", state: "open" } },
    });
    const sig = `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
    const req = (headers: Record<string, string>, rawBody = body) => ({
      headers,
      rawBody,
      url: "https://api.slai.dev/webhooks/intercom/conn_1",
    });
    expect(await c.handleWebhook(req({ "X-Hub-Signature": sig }), secret)).toEqual({
      ok: true,
      ticketSourceIds: ["555"],
    });
    expect(await c.handleWebhook(req({ "X-Hub-Signature": sig }), "other")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook(req({ "X-Hub-Signature": sig }, body.replace("555", "556")), secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook(req({}), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req({ "X-Hub-Signature": sig }), null)).toEqual({
      ok: false,
      reason: "bad_signature",
    });

    const ping = JSON.stringify({
      type: "notification_event",
      topic: "ping",
      data: { item: { type: "ping", message: "hi" } },
    });
    const psig = `sha1=${createHmac("sha1", secret).update(ping).digest("hex")}`;
    expect(await c.handleWebhook(req({ "x-hub-signature": psig }, ping), secret)).toEqual({
      ok: true,
      ticketSourceIds: [],
    });
    const junk = "not json";
    const jsig = `sha1=${createHmac("sha1", secret).update(junk).digest("hex")}`;
    expect(await c.handleWebhook(req({ "x-hub-signature": jsig }, junk), secret)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("maps 429 to rate_limited (Retry-After, then X-RateLimit-Reset)", async () => {
    const a = client([
      { method: "GET", url: /\/conversations\/555/, status: 429, responseHeaders: { "Retry-After": "10" } },
    ]);
    const e1 = await rejection(a.c.getTicketWithHistory("555"));
    expect([e1.kind, e1.retryAfterMs]).toEqual(["rate_limited", 10_000]);
    const b = client([
      { method: "GET", url: /\/conversations\/555/, status: 429, responseHeaders: { "X-RateLimit-Reset": "7" } },
    ]);
    const e2 = await rejection(b.c.getTicketWithHistory("555"));
    expect([e2.kind, e2.retryAfterMs]).toEqual(["rate_limited", 7_000]);
  });

  it("writes: note and reply as the token's admin, assignment, priority (Preview), tags", async () => {
    const { c, f } = client([
      { method: "GET", url: `${BASE}/me`, headers: HEADERS, fixture: "intercom/me.json" },
      {
        method: "POST",
        url: `${BASE}/conversations/555/reply`,
        headers: HEADERS,
        body: (b) =>
          expect(b).toEqual({ message_type: "note", type: "admin", admin_id: "991", body: "Drafted by slai" }),
        fixture: "intercom/reply-555.json",
      },
      {
        method: "POST",
        url: `${BASE}/conversations/555/reply`,
        body: (b) => expect(b).toEqual({ message_type: "comment", type: "admin", admin_id: "991", body: "Fixed!" }),
        fixture: "intercom/reply-555.json",
      },
      {
        method: "POST",
        url: `${BASE}/conversations/555/parts`,
        body: (b) =>
          expect(b).toEqual({ message_type: "assignment", type: "admin", admin_id: "991", assignee_id: "992" }),
        fixture: "intercom/reply-555.json",
      },
      {
        method: "PUT",
        url: `${BASE}/conversations/555`,
        headers: { "intercom-version": "Preview" },
        body: (b) => expect(b).toEqual({ priority: "medium", admin_id: "991" }),
        fixture: "intercom/reply-555.json",
      },
      {
        method: "POST",
        url: `${BASE}/tags`,
        body: (b) => expect(b).toEqual({ name: "vip" }),
        json: { type: "tag", id: "321", name: "vip" },
      },
      {
        method: "POST",
        url: `${BASE}/conversations/555/tags`,
        body: (b) => expect(b).toEqual({ id: "321", admin_id: "991" }),
        json: { type: "tag", id: "321", name: "vip" },
      },
    ]);
    expect(await c.postInternalNote("555", "Drafted by slai")).toEqual({ commentSourceId: "9001" });
    expect(await c.postPublicReply("555", "Fixed!")).toEqual({ commentSourceId: "9001" });
    await c.updateTicket("555", { assigneeSourceId: "992", priority: "normal", addTags: ["vip"] });
    expect(f.unused()).toEqual([]);
    expect(f.calls.filter((x) => x.url.endsWith("/me"))).toHaveLength(1); // admin id cached
  });

  it("uses a configured adminId without calling /me", async () => {
    const { c, f } = client(
      [
        {
          method: "POST",
          url: `${BASE}/conversations/555/reply`,
          body: (b) => expect(b.admin_id).toBe("42"),
          fixture: "intercom/reply-555.json",
        },
      ],
      { accessToken: "tok_ic", adminId: "42" },
    );
    await c.postInternalNote("555", "x");
    expect(f.unused()).toEqual([]);
  });
});

describe("intercom articles (knowledge)", () => {
  it("declares knowledge support", () => {
    expect(intercom.supportsKnowledge).toBe(true);
  });

  it("pages through published articles and their published translations as plain text, skipping drafts", async () => {
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}/articles?page=1&per_page=50`,
        headers: HEADERS,
        fixture: "intercom/articles-page1.json",
      },
      {
        method: "GET",
        url: `${BASE}/articles?page=2&per_page=50`,
        headers: HEADERS,
        fixture: "intercom/articles-page2.json",
      },
    ]);
    const p1 = await c.listKnowledgeArticles!(null);
    expect(p1.items).toEqual([
      {
        sourceId: "6871119",
        title: "Retry webhook deliveries",
        url: "https://intercom.help/acme/en/articles/6871119-retry-webhook-deliveries",
        bodyText: "Webhooks are retried for 24 hours.\n\nRespond within 10 seconds.",
        locale: "en",
        updatedAt: new Date(1758000000 * 1000),
      },
      // The French translation is its own item; the draft pt-BR one, the default-locale
      // copy and the non-object entries of translated_content are not.
      {
        sourceId: "6871119:fr",
        title: "Relancer les livraisons de webhooks",
        url: "https://intercom.help/acme/fr/articles/6871119-relancer-les-livraisons-de-webhooks",
        bodyText: "Les webhooks sont relancés pendant 24 heures.",
        locale: "fr",
        updatedAt: new Date(1758100000 * 1000),
      },
    ]);
    const p2 = await c.listKnowledgeArticles!(p1.nextCursor);
    expect(p2.items).toEqual([expect.objectContaining({ sourceId: "6871121", url: null, locale: "fr" })]);
    expect(p2.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
  });
});

describe("intercom macros (saved replies)", () => {
  it("declares saved-reply support", () => {
    expect(intercom.supportsSavedReplies).toBe(true);
  });

  it("pages through macros as text, keeping placeholder fallbacks", async () => {
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}/macros?per_page=150`,
        headers: HEADERS,
        fixture: "intercom/macros-page1.json",
      },
      {
        method: "GET",
        url: `${BASE}/macros?per_page=150&starting_after=WzE3MTk0OTM3NTcuMCwgIjEyNCJd`,
        headers: HEADERS,
        fixture: "intercom/macros-page2.json",
      },
    ]);
    const p1 = await c.listSavedReplies!(null);
    expect(p1.items).toEqual([
      {
        sourceId: "123",
        title: "Webhook delays",
        url: null,
        bodyText: "Hi there, webhooks are retried for 24 hours.",
        locale: null,
        updatedAt: new Date("2026-09-10T08:00:00.000Z"),
      },
      {
        // No body_text: the HTML body's <attribute/> placeholder (no default) is dropped.
        sourceId: "124",
        title: "Password reset",
        url: null,
        bodyText: "Hello,\n\nUse Forgot password on the sign-in page & check spam.",
        locale: null,
        updatedAt: new Date(1719493757 * 1000),
      },
    ]);
    const p2 = await c.listSavedReplies!(p1.nextCursor);
    // A macro that is nothing but a placeholder is empty and skipped.
    expect(p2).toEqual({ items: [], nextCursor: null });
    expect(f.unused()).toEqual([]);
  });

  it("reports a token without access to macros as unsupported", async () => {
    const { c } = client([{ method: "GET", url: `${BASE}/macros?per_page=150`, status: 403, json: { errors: [] } }]);
    expect(await rejection(c.listSavedReplies!(null))).toMatchObject({ kind: "unsupported" });
  });
});
