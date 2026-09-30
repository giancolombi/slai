import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { zammad } from "../src/connectors/zammad.js";
import { toEngineEvents } from "../src/lib/events.js";
import { fakeFetch, fixture, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://support.acme.example";
const AUTH = "Token token=zm_tok";

function client(routes: Route[], config: Record<string, unknown> = {}) {
  const f = fakeFetch(routes);
  const c = zammad.create({
    credentials: { baseUrl: `${BASE}/`, apiToken: "zm_tok" },
    config,
    mapping: zammad.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${BASE}/api/v1/tickets/42?expand=true`,
    headers: { authorization: AUTH },
    fixture: "zammad/ticket-42.json",
  },
  {
    method: "GET",
    url: `${BASE}/api/v1/ticket_history/42`,
    headers: { authorization: AUTH },
    fixture: "zammad/history-42.json",
  },
  {
    method: "GET",
    url: `${BASE}/api/v1/ticket_articles/by_ticket/42`,
    headers: { authorization: AUTH },
    fixture: "zammad/articles-42.json",
  },
  { method: "GET", url: `${BASE}/api/v1/tags?object=Ticket&o_id=42`, json: { tags: ["vip"] } },
];

describe("zammad connector", () => {
  it("tests the connection", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/api/v1/users/me`,
        headers: { authorization: AUTH },
        json: { id: 5, email: "dana@acme.com" },
      },
    ]);
    expect(await c.testConnection()).toEqual({
      accountName: "support.acme.example",
      accountId: "support.acme.example",
    });
  });

  it("searches updated tickets page by page and flags unmapped custom states", async () => {
    const q = 'updated_at:["2026-09-28T00:00:00.000Z" TO *]';
    const url = (page: number) =>
      `${BASE}/api/v1/tickets/search?query=${encodeURIComponent(q)}&sort_by=updated_at&order_by=asc&expand=true&page=${page}&per_page=2`;
    const { c } = client(
      [
        { method: "GET", url: url(1), headers: { authorization: AUTH }, fixture: "zammad/search-page1.json" },
        { method: "GET", url: url(2), fixture: "zammad/search-page2.json" },
      ],
      { pageSize: 2 },
    );
    const since = new Date("2026-09-28T00:00:00Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.priority])).toEqual([
      ["#31041", "closed", "normal"],
      ["#31042", "open", "high"],
    ]);
    expect(p1.items[0]?.assignee).toBeNull(); // owner id 1 = unassigned
    expect(p1.items[1]?.requester).toMatchObject({
      email: "liam.okafor@bluepeak.example",
      orgName: "Bluepeak Logistics",
    });
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    expect(p2.items[0]).toMatchObject({ status: "open", rawStatus: "waiting for vendor" });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "status", raw: "waiting for vendor" }]);
  });

  it("builds canonical events from history + articles: pending, internal vs public, system bot", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("42");
    expect(f.unused()).toEqual([]);
    const summary = h.events.map((e) => {
      if (e.type === "created") return `created:${e.status}:${e.priority}`;
      if (e.type === "status_changed") return `status:${e.status}:${e.rawStatus}`;
      if (e.type === "priority_changed") return `priority:${e.priority}`;
      if (e.type === "comment") return `comment:${e.author}:${e.public ? "public" : "internal"}`;
      if (e.type === "assignee_changed") return `assignee:${e.assigneeSourceId}`;
      return `tags:${e.tags.join(",")}`;
    });
    expect(summary).toEqual([
      "created:new:normal",
      "comment:requester:public",
      "comment:bot:public",
      "assignee:5",
      "comment:agent:internal",
      "status:pending:pending reminder",
      "comment:agent:public",
      "status:open:open",
      "comment:requester:public",
      "priority:high",
      "tags:vip",
    ]);
    expect(h.ticket).toMatchObject({ status: "open", priority: "high", tags: ["vip"], ref: { displayKey: "#31042" } });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["1001", "requester", true],
      ["1002", "bot", true],
      ["1003", "agent", false],
      ["1004", "agent", true],
      ["1005", "requester", true],
    ]);
    expect(h.comments[3]?.bodyText).toBe(
      "Hi Liam, can you confirm the webhook endpoint URL and whether it responds within 10 seconds?",
    );
    expect(h.events.find((e) => e.type === "comment")?.idempotencyKey).toBe("zammad:support.acme.example:article:1001");
  });

  it("end to end: FR met, next response breached after the customer's reply, resolution paused while pending", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("42");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T18:00:00Z"));
    expect(metric(ev, "first_response")).toMatchObject({ state: "achieved", elapsedMs: 90 * 60_000 });
    const nr = metric(ev, "next_response");
    expect(nr.state).toBe("breached"); // high: 120 min, 240 elapsed since 14:00
    expect(nr.cycles[0]?.breachAt?.toISOString()).toBe("2026-09-28T16:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(330 * 60_000);
  });

  it("verifies webhook signatures (X-Hub-Signature, HMAC-SHA1 hex)", async () => {
    const { c } = client([]);
    const body = JSON.stringify({ ticket: { id: 42, number: "31042", state: "open" }, article: { id: 1005 } });
    const sig = `sha1=${createHmac("sha1", "zm_secret").update(body).digest("hex")}`;
    const req = (s?: string) => ({
      headers: { "X-Hub-Signature": s, "X-Zammad-Trigger": "slai" },
      rawBody: body,
      url: "https://api.slai.dev/webhooks/zammad/conn_1",
    });
    expect(await c.handleWebhook(req(sig), "zm_secret")).toEqual({ ok: true, ticketSourceIds: ["42"] });
    expect(await c.handleWebhook(req(sig), "other")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined), "zm_secret")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sig), null)).toEqual({ ok: false, reason: "bad_signature" });
    const bad = "not json";
    const badSig = `sha1=${createHmac("sha1", "zm_secret").update(bad).digest("hex")}`;
    expect(await c.handleWebhook({ ...req(badSig), rawBody: bad }, "zm_secret")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("maps 429 to rate_limited", async () => {
    const { c } = client([{ method: "GET", url: /tickets\/42/, status: 429, responseHeaders: { "Retry-After": "5" } }]);
    const err = await rejection(c.getTicketWithHistory("42"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(5000);
  });

  it("writes notes, email replies, and updates", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/api/v1/ticket_articles`,
        headers: { authorization: AUTH },
        body: (b) =>
          expect(b).toEqual({
            ticket_id: 42,
            body: "Drafted by slai",
            content_type: "text/plain",
            type: "note",
            internal: true,
          }),
        json: { id: 1006 },
      },
      { method: "GET", url: `${BASE}/api/v1/tickets/42?expand=true`, fixture: "zammad/ticket-42.json" },
      { method: "GET", url: `${BASE}/api/v1/users/12`, json: { id: 12, email: "liam.okafor@bluepeak.example" } },
      {
        method: "POST",
        url: `${BASE}/api/v1/ticket_articles`,
        body: (b) =>
          expect(b).toMatchObject({
            ticket_id: 42,
            to: "liam.okafor@bluepeak.example",
            type: "email",
            internal: false,
          }),
        json: { id: 1007 },
      },
      {
        method: "PUT",
        url: `${BASE}/api/v1/tickets/42`,
        body: (b) => expect(b).toEqual({ priority: "3 high", owner_id: 5 }),
        json: { id: 42 },
      },
      {
        method: "POST",
        url: `${BASE}/api/v1/tags/add`,
        body: (b) => expect(b).toEqual({ object: "Ticket", o_id: 42, item: "vip" }),
        json: true,
      },
    ]);
    expect(await c.postInternalNote("42", "Drafted by slai")).toEqual({ commentSourceId: "1006" });
    expect(await c.postPublicReply("42", "Fixed on our side.")).toEqual({ commentSourceId: "1007" });
    await c.updateTicket("42", { priority: "high", assigneeSourceId: "5", addTags: ["vip"] });
    expect(f.unused()).toEqual([]);
    // No Zammad priority maps to urgent by default: refuse rather than send garbage.
    expect((await rejection(c.updateTicket("42", { priority: "urgent" }))).kind).toBe("invalid");
  });
});

describe("zammad text modules (saved replies)", () => {
  it("pages through active text modules as plain text, placeholders stripped", async () => {
    expect(zammad.supportsSavedReplies).toBe(true);
    // A full page (100) means there may be more; the short second page is the last.
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `Module ${i + 1}`,
      content: `<p>Text ${i + 1}</p>`,
      active: true,
      updated_at: "2026-04-01T08:00:00.000Z",
    }));
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}/api/v1/text_modules?page=1&per_page=100`,
        headers: { authorization: AUTH },
        json: full,
      },
      {
        method: "GET",
        url: `${BASE}/api/v1/text_modules?page=2&per_page=100`,
        headers: { authorization: AUTH },
        fixture: "zammad/text-modules-page2.json",
      },
    ]);
    const p1 = await c.listSavedReplies!(null);
    expect(p1.items).toHaveLength(100);
    expect(p1.items[0]).toMatchObject({ sourceId: "1", title: "Module 1", bodyText: "Text 1", url: null });
    const p2 = await c.listSavedReplies!(p1.nextCursor);
    expect(p2.items).toEqual([
      {
        sourceId: "101",
        title: "Password reset",
        url: null,
        bodyText: "Hi,\n\nYou can reset your password under Profile → Password; the link is valid for 24 hours.",
        locale: null,
        updatedAt: new Date("2026-05-01T08:00:00Z"),
      },
    ]);
    expect(p2.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
  });

  it("reports a token without access as unsupported, not an auth failure", async () => {
    const { c } = client([{ method: "GET", url: `${BASE}/api/v1/text_modules?page=1&per_page=100`, status: 403 }]);
    expect(await rejection(c.listSavedReplies!(null))).toMatchObject({ kind: "unsupported" });
  });
});

describe("zammad knowledge base", () => {
  const kbRoutes: Route[] = [
    {
      method: "POST",
      url: `${BASE}/api/v1/knowledge_bases/init`,
      headers: { authorization: AUTH },
      fixture: "zammad/kb-init.json",
    },
    { method: "GET", url: `${BASE}/api/v1/locales`, headers: { authorization: AUTH }, fixture: "zammad/locales.json" },
  ];

  it("lists publicly published answers in every locale, with bodies and public URLs", async () => {
    expect(zammad.supportsKnowledge).toBe(true);
    const { c, f } = client([
      ...kbRoutes,
      {
        method: "GET",
        url: `${BASE}/api/v1/knowledge_bases/1/answers/7?include_contents=30`,
        headers: { authorization: AUTH },
        fixture: "zammad/kb-answer-7-en.json",
      },
      {
        method: "GET",
        url: `${BASE}/api/v1/knowledge_bases/1/answers/7?include_contents=31`,
        headers: { authorization: AUTH },
        fixture: "zammad/kb-answer-7-de.json",
      },
    ]);
    const page = await c.listKnowledgeArticles!(null);
    // Internal-only (8), draft (9), archived (10) and scheduled (11) answers are left out.
    expect(page.items).toEqual([
      {
        sourceId: "7:en-us",
        title: "Reset your password",
        url: `${BASE}/help/en-us/3-getting-started/7-reset-your-password`,
        bodyText: "Open Profile → Password and choose Reset.\n\nThe link is valid for 24 hours.",
        locale: "en-us",
        updatedAt: new Date("2026-04-01T10:00:00Z"),
      },
      {
        sourceId: "7:de-de",
        title: "Passwort zurücksetzen",
        url: `${BASE}/help/de-de/3-erste-schritte/7-passwort-zurucksetzen`,
        bodyText: "Öffnen Sie Profil → Passwort.",
        locale: "de-de",
        updatedAt: new Date("2026-04-02T10:00:00Z"),
      },
    ]);
    expect(page.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
  });

  it("links answers under a custom path address, and none under a custom domain", async () => {
    const init = fixture("zammad/kb-init.json");
    const withAddress = (address: string) => ({
      ...init,
      KnowledgeBase: { "1": { ...init.KnowledgeBase["1"], custom_address: address } },
    });
    const answer = (content: string) => ({
      method: "GET",
      url: new RegExp(`/api/v1/knowledge_bases/1/answers/7\\?include_contents=${content}$`),
      fixture: `zammad/kb-answer-7-${content === "30" ? "en" : "de"}.json`,
    });
    for (const [address, url] of [
      ["/support/", `${BASE}/support/en-us/3-getting-started/7-reset-your-password`],
      ["help.acme.example", null],
    ] as const) {
      const { c } = client([
        { method: "POST", url: `${BASE}/api/v1/knowledge_bases/init`, json: withAddress(address) },
        kbRoutes[1]!,
        answer("30"),
        answer("31"),
      ]);
      expect((await c.listKnowledgeArticles!(null)).items[0]!.url).toBe(url);
    }
  });

  it("treats a Zammad without a knowledge base as empty, and a forbidden one as unsupported", async () => {
    const none = client([{ method: "POST", url: `${BASE}/api/v1/knowledge_bases/init`, status: 404 }]);
    expect(await none.c.listKnowledgeArticles!(null)).toEqual({ items: [], nextCursor: null });
    const forbidden = client([{ method: "POST", url: `${BASE}/api/v1/knowledge_bases/init`, status: 403 }]);
    expect(await rejection(forbidden.c.listKnowledgeArticles!(null))).toMatchObject({ kind: "unsupported" });
  });
});
