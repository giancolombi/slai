import { createSign, generateKeyPairSync } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { zohoDesk } from "../src/connectors/zoho-desk.js";
import { toEngineEvents } from "../src/lib/events.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const API = "https://desk.zoho.com/api/v1";
const ORG = "60012345";
const TID = "481520000001234001";
const AUTH = "Zoho-oauthtoken zd_access_1";
const CREDS = {
  dataCenter: "com",
  orgId: ORG,
  clientId: "1000.CLIENTID",
  clientSecret: "zd_client_secret",
  refreshToken: "1000.refresh.tok",
};

const tokenRoute: Route = {
  method: "POST",
  url: "https://accounts.zoho.com/oauth/v2/token?refresh_token=1000.refresh.tok&client_id=1000.CLIENTID&client_secret=zd_client_secret&grant_type=refresh_token",
  json: { access_token: "zd_access_1", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 },
};
const H = { authorization: AUTH, orgid: ORG };

function client(routes: Route[], config: Record<string, unknown> = {}, credentials: Record<string, unknown> = CREDS) {
  const f = fakeFetch(routes);
  const c = zohoDesk.create({
    credentials: zohoDesk.credentialsSchema.parse(credentials),
    config,
    mapping: zohoDesk.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes: Route[] = [
  tokenRoute,
  {
    method: "GET",
    url: `${API}/tickets/${TID}?include=contacts,assignee`,
    headers: H,
    fixture: "zoho_desk/ticket-1042.json",
  },
  {
    method: "GET",
    url: `${API}/tickets/${TID}/History?from=0&limit=50`,
    headers: H,
    fixture: "zoho_desk/history-1042.json",
  },
  {
    method: "GET",
    url: `${API}/tickets/${TID}/threads?from=0&limit=100`,
    headers: H,
    fixture: "zoho_desk/threads-1042.json",
  },
  {
    method: "GET",
    url: `${API}/tickets/${TID}/comments?from=0&limit=100`,
    headers: H,
    fixture: "zoho_desk/comments-1042.json",
  },
  {
    method: "GET",
    url: `${API}/tickets/${TID}/tags`,
    json: { data: [{ id: "481520000000900001", name: "vip", tagType: "MANUAL" }] },
  },
];

describe("zoho desk connector", () => {
  it("exchanges the refresh token and tests the connection", async () => {
    const { c, f } = client([
      tokenRoute,
      {
        method: "GET",
        url: `${API}/organizations/${ORG}`,
        headers: H,
        json: { id: 60012345, companyName: "Northwind Analytics", portalName: "northwind" },
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "Northwind Analytics", accountId: ORG });
    expect(f.unused()).toEqual([]);
    expect(f.calls[0]?.method).toBe("POST");
  });

  it("uses the data centre's hosts and reports a rejected refresh token as auth", async () => {
    const { c } = client(
      [
        {
          method: "POST",
          url: /^https:\/\/accounts\.zohocloud\.ca\/oauth\/v2\/token\?/,
          json: { error: "invalid_code" },
        },
      ],
      {},
      { ...CREDS, dataCenter: "ca" },
    );
    expect((await rejection(c.testConnection())).kind).toBe("auth");
    expect(zohoDesk.credentialsSchema.safeParse({ ...CREDS, dataCenter: "zoho.com" }).success).toBe(false);
  });

  it("lists updated tickets newest first, stops at since, and flags unmapped custom values", async () => {
    const url = (from: number) => `${API}/tickets?from=${from}&limit=2&sortBy=-modifiedTime&include=contacts,assignee`;
    const { c, f } = client(
      [
        tokenRoute,
        { method: "GET", url: url(0), headers: H, fixture: "zoho_desk/tickets-page1.json" },
        { method: "GET", url: url(2), headers: H, fixture: "zoho_desk/tickets-page2.json" },
      ],
      { pageSize: 2 },
    );
    const since = new Date("2026-09-28T00:00:00Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.priority])).toEqual([
      ["#1042", "open", "high"],
      ["#1039", "closed", "low"],
    ]);
    expect(p1.items[0]).toMatchObject({
      ref: {
        sourceId: TID,
        url: "https://desk.zoho.com/support/northwind/ShowHomePage.do#Cases/dv/481520000001234001",
      },
      requester: {
        sourceId: "481520000000572348",
        email: "liam.okafor@bluepeak.example",
        name: "Liam Okafor",
        orgSourceId: "481520000000480011",
        orgName: "Bluepeak Logistics",
      },
      assignee: { sourceId: "481520000000195001", name: "Priya Raman" },
      groupSourceId: "481520000000006907",
      channel: "Email",
      mappingIssues: [],
    });
    expect(p1.items[1]?.assignee).toBeNull();
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    // #1031 was modified before `since`: dropped, and paging stops.
    expect(p2.items.map((t) => t.ref.displayKey)).toEqual(["#1040"]);
    expect(p2.nextCursor).toBeNull();
    // Custom status falls back to its statusType (On Hold), but is still flagged for mapping.
    expect(p2.items[0]).toMatchObject({ status: "on_hold", rawStatus: "Awaiting Vendor", priority: null });
    expect(p2.items[0]?.mappingIssues).toEqual([
      { field: "status", raw: "Awaiting Vendor" },
      { field: "priority", raw: "Urgent" },
    ]);
    expect(f.unused()).toEqual([]);
  });

  it("treats a 204 (empty list) as the last page", async () => {
    const { c } = client([tokenRoute, { method: "GET", url: /\/api\/v1\/tickets\?/, status: 204 }]);
    expect(await c.listUpdatedTickets(new Date("2026-09-28T00:00:00Z"), null)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("builds canonical events from history + threads + comments: pending, reopen, internal vs public, bot", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory(TID);
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
      "created:open:normal",
      "comment:requester:public",
      // Workflow auto-acknowledgement (author type SYSTEM) is a bot reply.
      "comment:bot:public",
      "assignee:481520000000195001",
      "comment:agent:internal",
      "status:pending:Waiting on Customer",
      "comment:agent:public",
      "status:open:Open",
      "comment:requester:public",
      "priority:high",
    ]);
    expect(h.ticket).toMatchObject({
      status: "open",
      priority: "high",
      rawPriority: "High",
      tags: ["vip"],
      ref: { displayKey: "#1042" },
    });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["481520000001234007", "requester", true],
      ["481520000001234011", "bot", true],
      ["481520000001236001", "agent", false],
      ["481520000001238003", "agent", true],
      ["481520000001240005", "requester", true],
    ]);
    expect(h.comments[0]?.bodyText).toBe("Since this morning every webhook delivery to our endpoint times out.");
    expect(h.comments[2]).toMatchObject({
      authorName: "Priya Raman",
      authorSourceId: "481520000000195001",
      bodyText: "Checked the delivery logs: 30s timeouts from the EU relay only.",
    });
    expect(h.events.find((e) => e.type === "comment")?.idempotencyKey).toBe(
      "zoho_desk:60012345:thread:481520000001234007",
    );
    expect(h.events.find((e) => e.type === "status_changed")?.idempotencyKey).toBe(
      "zoho_desk:60012345:history:481520000001234001:2026-09-28T10:30:00.000Z:TicketUpdated:Status",
    );
    // Same source data → same keys (webhook vs poll).
    const again = await client(historyRoutes).c.getTicketWithHistory(TID);
    expect(again.events.map((e) => e.idempotencyKey)).toEqual(h.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met, next response breached after the customer's reply, resolution paused while pending", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory(TID);
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T18:00:00Z"));
    // Created 09:00 (Medium → normal, 240 min); agent reply 10:30. The 09:01 bot ack doesn't count.
    expect(metric(ev, "first_response")).toMatchObject({ state: "achieved", elapsedMs: 90 * 60_000 });
    const nr = metric(ev, "next_response");
    expect(nr.state).toBe("breached"); // high since 15:00: 120 min from the 14:00 customer reply
    expect(nr.elapsedMs).toBe(240 * 60_000);
    expect(nr.cycles[0]?.breachAt?.toISOString()).toBe("2026-09-28T16:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    // 09:00–10:30 (90) + paused while Waiting on Customer + 14:00–18:00 (240).
    expect(res.elapsedMs).toBe(330 * 60_000);
  });

  describe("webhooks (X-ZDesk-JWT, RS256 over Zoho's JWKS)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const WEBHOOK_ID = "481520000009000001";
    const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "zd-key-1", use: "sig", alg: "RS256" }] };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const sign = (claims: Record<string, unknown>, key = privateKey, kid = "zd-key-1") => {
      const unsigned = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(claims)}`;
      const sig = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
      return `${unsigned}.${sig}`;
    };
    const claims = (over: Record<string, unknown> = {}) => ({
      iss: ORG,
      aud: WEBHOOK_ID,
      iat: Date.now(),
      exp: Date.now() + 5 * 60_000,
      ...over,
    });
    const body = JSON.stringify([
      {
        payload: { id: TID, ticketNumber: "1042", status: "Open", statusType: "Open" },
        eventTime: "1790600400000",
        eventType: "Ticket_Update",
        orgId: ORG,
      },
      {
        payload: { id: "481520000001240009", ticketId: "481520000001229001", direction: "in" },
        eventTime: "1790600460000",
        eventType: "Ticket_Thread_Add",
        orgId: ORG,
      },
    ]);
    const req = (jwt?: string, rawBody = body) => ({
      headers: { "X-ZDesk-JWT": jwt, "Content-Type": "application/json" },
      rawBody,
      url: "https://api.slai.dev/webhooks/zoho_desk/conn_1",
    });
    const jwksRoute: Route = {
      method: "GET",
      url: "https://desk.zoho.com/.well-known/jwks.json",
      json: jwks,
      repeat: true,
    };

    it("accepts a valid token and returns the ticket ids", async () => {
      const { c } = client([jwksRoute]);
      expect(await c.handleWebhook(req(sign(claims())), WEBHOOK_ID)).toEqual({
        ok: true,
        ticketSourceIds: [TID, "481520000001229001"],
      });
    });

    it("rejects wrong webhook id, wrong org, expired, foreign key, missing header, and a null secret", async () => {
      const { c } = client([jwksRoute]);
      const bad = { ok: false, reason: "bad_signature" };
      expect(await c.handleWebhook(req(sign(claims())), "481520000009000002")).toEqual(bad);
      expect(await c.handleWebhook(req(sign(claims({ iss: "70099999" }))), WEBHOOK_ID)).toEqual(bad);
      expect(await c.handleWebhook(req(sign(claims({ exp: Date.now() - 1000 }))), WEBHOOK_ID)).toEqual(bad);
      expect(await c.handleWebhook(req(sign(claims(), other.privateKey)), WEBHOOK_ID)).toEqual(bad);
      expect(await c.handleWebhook(req(sign(claims(), privateKey, "unknown-kid")), WEBHOOK_ID)).toEqual(bad);
      expect(await c.handleWebhook(req("not.a.jwt"), WEBHOOK_ID)).toEqual(bad);
      expect(await c.handleWebhook(req(undefined), WEBHOOK_ID)).toEqual(bad);
      expect(await c.handleWebhook(req(sign(claims())), null)).toEqual(bad);
    });

    it("refetches the JWKS for an unknown key id at most once a minute", async () => {
      const { c, f } = client([jwksRoute]);
      const forged = req(sign(claims(), privateKey, "unknown-kid"));
      for (let i = 0; i < 5; i++) {
        expect(await c.handleWebhook(forged, WEBHOOK_ID)).toEqual({ ok: false, reason: "bad_signature" });
      }
      expect(f.calls.filter((x) => x.url.endsWith("/jwks.json"))).toHaveLength(1);
    });

    it("rejects an unsigned delivery without any network call", async () => {
      const { c, f } = client([]);
      expect(
        await c.handleWebhook(
          { headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/webhooks/x" },
          "secret",
        ),
      ).toEqual({ ok: false, reason: "bad_signature" });
      expect(f.calls).toEqual([]);
    });

    it("flags a validly signed non-JSON body as malformed", async () => {
      const { c } = client([jwksRoute]);
      expect(await c.handleWebhook(req(sign(claims()), "not json"), WEBHOOK_ID)).toEqual({
        ok: false,
        reason: "malformed",
      });
    });
  });

  it("maps 429 to rate_limited", async () => {
    const { c } = client([
      tokenRoute,
      { method: "GET", url: /tickets\/481520000001234001/, status: 429, responseHeaders: { "Retry-After": "7" } },
    ]);
    const err = await rejection(c.getTicketWithHistory(TID));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(7000);
  });

  it("writes internal comments, email replies, and updates (priority, assignee, tags)", async () => {
    const { c, f } = client([
      tokenRoute,
      {
        method: "POST",
        url: `${API}/tickets/${TID}/comments`,
        headers: H,
        body: (b) => expect(b).toEqual({ isPublic: false, contentType: "html", content: "<p>Drafted by slai</p>" }),
        json: { id: "481520000001241001", isPublic: false },
      },
      { method: "GET", url: `${API}/tickets/${TID}?include=contacts,assignee`, fixture: "zoho_desk/ticket-1042.json" },
      {
        method: "GET",
        url: `${API}/tickets/${TID}/threads?from=0&limit=100`,
        fixture: "zoho_desk/threads-1042.json",
      },
      {
        method: "POST",
        url: `${API}/tickets/${TID}/sendReply`,
        headers: H,
        body: (b) =>
          expect(b).toEqual({
            channel: "EMAIL",
            to: "liam.okafor@bluepeak.example",
            fromEmailAddress: "support@northwind.example",
            contentType: "html",
            content: "<p>Fixed on our side.</p>",
          }),
        json: { id: "481520000001241003", channel: "EMAIL", direction: "out" },
      },
      {
        method: "PATCH",
        url: `${API}/tickets/${TID}`,
        headers: H,
        body: (b) => expect(b).toEqual({ priority: "High", assigneeId: "481520000000195001" }),
        json: { id: TID },
      },
      {
        method: "POST",
        url: `${API}/tickets/${TID}/associateTag`,
        headers: H,
        body: (b) => expect(b).toEqual({ tags: ["vip", "sla-risk"] }),
        json: { data: [{ id: "481520000000900001", name: "vip", tagType: "MANUAL" }] },
      },
    ]);
    expect(await c.postInternalNote(TID, "Drafted by slai")).toEqual({ commentSourceId: "481520000001241001" });
    expect(await c.postPublicReply(TID, "Fixed on our side.")).toEqual({ commentSourceId: "481520000001241003" });
    await c.updateTicket(TID, {
      priority: "high",
      assigneeSourceId: "481520000000195001",
      addTags: ["vip", "sla-risk"],
    });
    expect(f.unused()).toEqual([]);
    // Zoho's default layout has no Urgent priority: refuse rather than send garbage.
    expect((await rejection(c.updateTicket(TID, { priority: "urgent" }))).kind).toBe("invalid");
  });

  it("replies from the configured support address without reading threads", async () => {
    const { c, f } = client(
      [
        tokenRoute,
        {
          method: "GET",
          url: `${API}/tickets/${TID}?include=contacts,assignee`,
          fixture: "zoho_desk/ticket-1042.json",
        },
        {
          method: "POST",
          url: `${API}/tickets/${TID}/sendReply`,
          body: (b) => expect(b).toMatchObject({ fromEmailAddress: "help@northwind.example" }),
          json: { id: "481520000001241005" },
        },
      ],
      { fromEmailAddress: "help@northwind.example" },
    );
    expect(await c.postPublicReply(TID, "On it.")).toEqual({ commentSourceId: "481520000001241005" });
    expect(f.unused()).toEqual([]);
  });
});
