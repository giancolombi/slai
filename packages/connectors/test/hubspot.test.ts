import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { decodeHubspotUri, hubspot, KB_API, KB_SCOPE, TICKET_PROPERTIES } from "../src/connectors/hubspot.js";
import { toEngineEvents } from "../src/lib/events.js";
import { authorizeUrl } from "../src/lib/oauth.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://api.hubapi.com";
const AUTH = "Bearer pat-na1-test";

function client(routes: Route[]) {
  const f = fakeFetch(routes);
  const c = hubspot.create({
    credentials: { accessToken: "pat-na1-test" },
    config: { portalId: 4242 },
    mapping: hubspot.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes = (): Route[] => [
  {
    method: "GET",
    url: `${BASE}/crm/v3/objects/tickets/5001?properties=${TICKET_PROPERTIES.join(",")}&propertiesWithHistory=hs_pipeline_stage,hs_ticket_priority,hubspot_owner_id&associations=emails,notes,contacts,companies`,
    headers: { authorization: AUTH },
    fixture: "hubspot/ticket-5001.json",
  },
  {
    method: "POST",
    url: `${BASE}/crm/v3/objects/emails/batch/read`,
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: (b) => expect(b.inputs).toEqual([{ id: "9001" }, { id: "9002" }, { id: "9003" }, { id: "9004" }]),
    fixture: "hubspot/emails-batch.json",
  },
  {
    method: "POST",
    url: `${BASE}/crm/v3/objects/notes/batch/read`,
    body: (b) => expect(b.inputs).toEqual([{ id: "9501" }]),
    fixture: "hubspot/notes-batch.json",
  },
  {
    method: "POST",
    url: `${BASE}/crm/v3/objects/contacts/batch/read`,
    body: (b) => expect(b).toEqual({ properties: ["email", "firstname", "lastname"], inputs: [{ id: "301" }] }),
    json: {
      status: "COMPLETE",
      results: [
        {
          id: "301",
          properties: { email: "maya.chen@northwind.example", firstname: "Maya", lastname: "Chen" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: false,
        },
      ],
    },
  },
  {
    method: "POST",
    url: `${BASE}/crm/v3/objects/companies/batch/read`,
    json: {
      status: "COMPLETE",
      results: [{ id: "401", properties: { name: "Northwind Analytics", domain: "northwind.example" } }],
    },
  },
];

describe("hubspot connector", () => {
  it("tests the connection", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}/account-info/v3/details`,
        headers: { authorization: AUTH },
        json: { portalId: 4242, accountType: "STANDARD", timeZone: "US/Eastern", uiDomain: "app.hubspot.com" },
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "HubSpot portal 4242", accountId: "4242" });
  });

  it("searches updated tickets, paginates with after, and re-anchors before the 10k cap", async () => {
    const since = new Date("2026-09-28T00:00:00Z");
    const searchBody = (s: number, after?: string) => (b: Record<string, unknown>) => {
      expect(b.filterGroups).toEqual([
        { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(s) }] },
      ]);
      expect(b.sorts).toEqual([{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }]);
      expect(b.limit).toBe(100);
      expect(b.after).toBe(after);
    };
    const reanchor = Date.parse("2026-09-29T09:30:00.000Z");
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/crm/v3/objects/tickets/search`,
        headers: { authorization: AUTH },
        body: searchBody(since.getTime()),
        fixture: "hubspot/search-page1.json",
      },
      {
        method: "POST",
        url: `${BASE}/crm/v3/objects/tickets/search`,
        body: searchBody(since.getTime(), "1"),
        fixture: "hubspot/search-page2.json",
      },
      {
        method: "POST",
        url: `${BASE}/crm/v3/objects/tickets/search`,
        body: searchBody(reanchor),
        json: { total: 0, results: [] },
      },
    ]);
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items[0]).toMatchObject({
      ref: { sourceId: "5001", url: "https://app.hubspot.com/contacts/4242/ticket/5001" },
      status: "open",
      rawStatus: "3",
      priority: "urgent",
      channel: "email",
      assignee: { sourceId: "777" },
    });
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    // Custom pipeline stage: defaulted to open and flagged.
    expect(p2.items[0]).toMatchObject({ status: "open", rawStatus: "123456", priority: null });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "status", raw: "123456" }]);
    const p3 = await c.listUpdatedTickets(since, p2.nextCursor);
    expect(p3).toEqual({ items: [], nextCursor: null });
    expect(f.unused()).toEqual([]);
  });

  it("builds events from property history, emails and notes", async () => {
    const { c, f } = client(historyRoutes());
    const h = await c.getTicketWithHistory("5001");
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
      "created:new:high",
      "comment:requester:public",
      "comment:agent:internal",
      "assignee:777",
      "comment:agent:public",
      "status:pending:2",
      "comment:requester:public",
      "status:open:3",
      "comment:agent:public",
      "status:closed:4",
      "comment:requester:public",
      "status:open:3",
      "priority:urgent",
    ]);
    expect(h.ticket.requester).toEqual({
      sourceId: "301",
      email: "maya.chen@northwind.example",
      name: "Maya Chen",
      orgSourceId: "401",
      orgName: "Northwind Analytics",
    });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["5001:content", "requester", true],
      ["9501", "agent", false],
      ["9001", "agent", true],
      ["9002", "requester", true],
      ["9003", "agent", true],
      ["9004", "requester", true],
    ]);
    expect(h.comments.find((x) => x.sourceId === "9002")?.bodyText).toBe("About 5 million rows.");
    expect(h.events.find((e) => e.type === "status_changed")?.idempotencyKey).toBe(
      "hubspot:ticket:5001:hs_pipeline_stage:2026-09-28T09:30:00.000Z:2",
    );
  });

  it("history keys are stable across fetches", async () => {
    const a = await client(historyRoutes()).c.getTicketWithHistory("5001");
    const b = await client(historyRoutes()).c.getTicketWithHistory("5001");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
    expect(new Set(a.events.map((e) => e.idempotencyKey)).size).toBe(a.events.length);
  });

  it("end to end: FR met, next response breached after reopen, resolution paused while waiting on contact", async () => {
    const h = await client(historyRoutes()).c.getTicketWithHistory("5001");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-29T10:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(30 * 60_000); // the internal note at 09:20 did not count
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => x.state)).toEqual(["achieved", "breached"]);
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-29T09:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(210 * 60_000); // 30 + 60 + 120; 09:30–11:00 pending excluded
    expect(ev.risk).toBe("breached");
  });

  it("verifies v3 webhook signatures and rejects bad, stale, or missing ones", async () => {
    const { c } = client([]);
    const secret = "client-secret";
    const url = "https://api.slai.dev/webhooks/hubspot/conn_1?tag=a%3Ab";
    const body = JSON.stringify([
      {
        eventId: 1,
        subscriptionId: 10,
        portalId: 4242,
        appId: 7,
        occurredAt: 1790672400000,
        subscriptionType: "ticket.propertyChange",
        attemptNumber: 0,
        objectId: 5001,
        propertyName: "hs_pipeline_stage",
        propertyValue: "3",
        changeSource: "CRM_UI",
      },
      { eventId: 2, subscriptionType: "contact.creation", objectId: 301, occurredAt: 1790672400000 },
      { eventId: 3, eventType: "ticket.creation", objectId: 5002, occurredAt: 1790672400000 },
      { eventId: 4, subscriptionType: "object.propertyChange", objectTypeId: "0-5", objectId: 5001 },
    ]);
    const sign = (ts: string, b = body) =>
      createHmac("sha256", secret)
        .update(`POST${decodeHubspotUri(url)}${b}${ts}`)
        .digest("base64");
    const now = String(Date.now());
    const req = (sig: string | undefined, ts: string | undefined) => ({
      headers: { "X-HubSpot-Signature-v3": sig, "X-HubSpot-Request-Timestamp": ts },
      rawBody: body,
      url,
    });
    expect(decodeHubspotUri(url)).toBe("https://api.slai.dev/webhooks/hubspot/conn_1?tag=a:b");
    expect(await c.handleWebhook(req(sign(now), now), secret)).toEqual({ ok: true, ticketSourceIds: ["5001", "5002"] });
    expect(await c.handleWebhook(req(sign(now), now), "wrong")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook({ ...req(sign(now), now), rawBody: `${body} ` }, secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const stale = String(Date.now() - 6 * 60_000);
    expect(await c.handleWebhook(req(sign(stale), stale), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined, now), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sign(now), now), null)).toEqual({ ok: false, reason: "bad_signature" });
    const bad = "{not json";
    expect(await c.handleWebhook({ headers: req(sign(now, bad), now).headers, rawBody: bad, url }, secret)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { c } = client([
      {
        method: "POST",
        url: `${BASE}/crm/v3/objects/tickets/search`,
        status: 429,
        responseHeaders: { "Retry-After": "10" },
        json: { status: "error", message: "You have reached your secondly limit.", category: "RATE_LIMITS" },
      },
    ]);
    const err = await rejection(c.listUpdatedTickets(new Date(0), null));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(10_000);
  });

  it("writes internal notes and property updates; public replies and tags are unsupported", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${BASE}/crm/v3/objects/notes`,
        headers: { authorization: AUTH },
        body: (b) => {
          expect(b.properties.hs_note_body).toBe("<p>Drafted by slai</p>");
          expect(Number.isNaN(Date.parse(b.properties.hs_timestamp))).toBe(false);
          expect(b.associations).toEqual([
            { to: { id: "5001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 }] },
          ]);
        },
        json: { id: "9601", properties: {}, createdAt: "2026-09-29T10:00:00.000Z" },
      },
      {
        method: "PATCH",
        url: `${BASE}/crm/v3/objects/tickets/5001`,
        body: (b) => expect(b).toEqual({ properties: { hs_ticket_priority: "URGENT", hubspot_owner_id: "777" } }),
        json: { id: "5001", properties: {} },
      },
    ]);
    expect(await c.postInternalNote("5001", "Drafted by slai")).toEqual({ commentSourceId: "9601" });
    await c.updateTicket("5001", { priority: "urgent", assigneeSourceId: "777" });
    expect((await rejection(c.postPublicReply("5001", "hi"))).kind).toBe("unsupported");
    expect((await rejection(c.updateTicket("5001", { priority: "low", addTags: ["vip"] }))).kind).toBe("unsupported");
    expect(f.unused()).toEqual([]);
    expect(hubspot.write).toEqual({
      internalNote: true,
      publicReply: false,
      assign: true,
      priority: true,
      tags: false,
    });
  });
});

describe("hubspot knowledge base (beta)", () => {
  it("pages through published articles in every language, skipping drafts", async () => {
    expect(hubspot.supportsKnowledge).toBe(true);
    const { c, f } = client([
      {
        method: "GET",
        url: `${BASE}${KB_API}/articles?state=PUBLISHED&limit=100`,
        headers: { authorization: AUTH },
        fixture: "hubspot/kb-articles-page1.json",
      },
      {
        method: "GET",
        // The percent-encoded `after` is sent once-encoded, as in HubSpot's own next link.
        url: `${BASE}${KB_API}/articles?state=PUBLISHED&limit=100&after=MjU%3D`,
        headers: { authorization: AUTH },
        fixture: "hubspot/kb-articles-page2.json",
      },
    ]);
    const p1 = await c.listKnowledgeArticles!(null);
    expect(p1.items).toEqual([
      {
        sourceId: "179889003802",
        title: "Reset your password",
        url: "https://help.acme.example/knowledge/reset-your-password",
        bodyText: "Open Profile → Password and choose Reset.\n\nThe link is valid for 24 hours.",
        locale: "en",
        updatedAt: new Date("2026-04-01T10:00:00Z"),
      },
      expect.objectContaining({ sourceId: "179889003803", locale: "es", title: "Restablecer la contraseña" }),
    ]);
    const p2 = await c.listKnowledgeArticles!(p1.nextCursor);
    expect(p2.items.map((a) => a.sourceId)).toEqual(["179889003901"]);
    expect(p2.nextCursor).toBeNull();
    expect(f.unused()).toEqual([]);
  });

  it("reports a portal without the scope or plan as unsupported, not an auth failure", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${BASE}${KB_API}/articles?state=PUBLISHED&limit=100`,
        status: 403,
        json: { category: "MISSING_SCOPES" },
      },
    ]);
    expect(await rejection(c.listKnowledgeArticles!(null))).toMatchObject({ kind: "unsupported" });
  });

  it("asks for the knowledge base scope as optional in OAuth", () => {
    const url = new URL(
      authorizeUrl(hubspot.oauth!, { clientId: "cid", redirectUri: "https://slai.example/cb", state: "s", params: {} }),
    );
    expect(url.searchParams.get("optional_scope")).toBe(KB_SCOPE);
    expect(url.searchParams.get("scope")).not.toContain(KB_SCOPE);
  });
});
