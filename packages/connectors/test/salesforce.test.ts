import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { type SalesforceCredentials, salesforce } from "../src/connectors/salesforce.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { FieldMapping } from "../src/types.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://northwind.my.salesforce.com";
const DATA = `${BASE}/services/data/v66.0`;
const AUTH = "Bearer 00DHs0000001nWz!AQEAQFakeAccessTokenForTests";
const CASE = "500Hs00001XyZ1AAAA";
const CREDS = { instanceUrl: `${BASE}/`, clientId: "3MVG9_northwind_key", clientSecret: "sf_secret" };

const q = (soql: string) => `${DATA}/query?q=${encodeURIComponent(soql)}`;
const tokenRoute: Route = {
  method: "POST",
  url: `${BASE}/services/oauth2/token`,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  fixture: "salesforce/token.json",
};

/**
 * fakeFetch only decodes JSON bodies, so form-encoded token requests are
 * captured here before being passed on.
 */
function client(
  routes: Route[],
  opts: { credentials?: Partial<SalesforceCredentials>; config?: Record<string, unknown>; mapping?: FieldMapping } = {},
) {
  const f = fakeFetch(routes);
  const forms: Record<string, string>[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof URLSearchParams) forms.push(Object.fromEntries(init.body));
    return f.fetch(input, init);
  }) as typeof globalThis.fetch;
  const c = salesforce.create({
    credentials: { ...CREDS, ...opts.credentials } as SalesforceCredentials,
    config: opts.config ?? {},
    mapping: opts.mapping ?? salesforce.defaultMapping,
    fetch,
  });
  return { c, f, forms };
}

const CASE_FIELDS =
  "Id, CaseNumber, Subject, Description, Status, Priority, IsClosed, Origin, OwnerId, Owner.Name, ContactId, ContactEmail, Contact.Name, AccountId, Account.Name, CreatedDate, SystemModstamp";

const historyRoutes: Route[] = [
  tokenRoute,
  {
    method: "GET",
    url: q(`SELECT ${CASE_FIELDS} FROM Case WHERE Id = '${CASE}'`),
    headers: { authorization: AUTH },
    fixture: "salesforce/case-1042.json",
  },
  {
    method: "GET",
    url: q(
      `SELECT Id, Field, DataType, OldValue, NewValue, CreatedDate FROM CaseHistory WHERE CaseId = '${CASE}' ORDER BY CreatedDate, Id`,
    ),
    headers: { authorization: AUTH },
    fixture: "salesforce/history-1042-page1.json",
  },
  {
    method: "GET",
    url: `${DATA}/query/0r8Hs00000Qry02AAA-6`,
    headers: { authorization: AUTH },
    fixture: "salesforce/history-1042-page2.json",
  },
  {
    method: "GET",
    url: q(
      `SELECT Id, IsPublished, CommentBody, CreatedDate, CreatedById, CreatedBy.Name, CreatedBy.UserType FROM CaseComment WHERE ParentId = '${CASE}' ORDER BY CreatedDate, Id`,
    ),
    fixture: "salesforce/comments-1042.json",
  },
  {
    method: "GET",
    url: q(
      `SELECT Id, Incoming, FromName, FromAddress, TextBody, HtmlBody, CreatedDate, CreatedById, CreatedBy.Name, CreatedBy.UserType FROM EmailMessage WHERE ParentId = '${CASE}' ORDER BY CreatedDate, Id`,
    ),
    fixture: "salesforce/emails-1042.json",
  },
];

describe("salesforce connector", () => {
  it("tests the connection with the client credentials grant", async () => {
    const { c, forms, f } = client([
      tokenRoute,
      {
        method: "GET",
        url: q("SELECT Id, Name FROM Organization LIMIT 1"),
        headers: { authorization: AUTH },
        json: { totalSize: 1, done: true, records: [{ Id: "00DHs0000001nWzMAI", Name: "Northwind Software" }] },
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "Northwind Software", accountId: "00DHs0000001nWzMAI" });
    expect(forms).toEqual([
      { grant_type: "client_credentials", client_id: "3MVG9_northwind_key", client_secret: "sf_secret" },
    ]);
    expect(f.unused()).toEqual([]);
  });

  it("uses the refresh token grant when a refresh token is given, and maps invalid_grant to auth", async () => {
    const { c, forms } = client(
      [
        {
          method: "POST",
          url: `${BASE}/services/oauth2/token`,
          status: 400,
          json: { error: "invalid_grant", error_description: "expired access/refresh token" },
        },
      ],
      { credentials: { refreshToken: "5Aep861_refresh" } },
    );
    const err = await rejection(c.testConnection());
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("invalid_grant");
    expect(err.message).not.toContain("sf_secret");
    expect(forms).toEqual([
      {
        grant_type: "refresh_token",
        client_id: "3MVG9_northwind_key",
        client_secret: "sf_secret",
        refresh_token: "5Aep861_refresh",
      },
    ]);
  });

  it("queries updated cases via nextRecordsUrl and flags unmapped values (IsClosed wins for closed ones)", async () => {
    const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE SystemModstamp >= 2026-09-28T00:00:00Z ORDER BY SystemModstamp, Id`;
    const { c, f } = client([
      tokenRoute,
      { method: "GET", url: q(soql), headers: { authorization: AUTH }, fixture: "salesforce/cases-page1.json" },
      {
        method: "GET",
        url: `${DATA}/query/0r8Hs00000Qry01AAA-2`,
        headers: { authorization: AUTH },
        fixture: "salesforce/cases-page2.json",
      },
    ]);
    const since = new Date("2026-09-28T00:00:00.250Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.priority])).toEqual([
      ["#00001042", "open", "high"],
      ["#00001043", "new", "low"],
    ]);
    expect(p1.items[0]).toMatchObject({
      assignee: { sourceId: "005Hs00000Agnt1AAA", name: "Priya Raman" },
      requester: {
        email: "tomas.lindqvist@harborline.example",
        name: "Tomas Lindqvist",
        orgName: "Harborline Freight",
      },
      channel: "web",
      ref: { url: `${BASE}/lightning/r/Case/${CASE}/view` },
      mappingIssues: [],
    });
    // Owned by a queue: no assignee, the queue is the group.
    expect(p1.items[1]).toMatchObject({ assignee: null, groupSourceId: "00GHs00000Tier1AAA" });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    expect(p2.items[0]).toMatchObject({ status: "open", rawStatus: "Escalated to Engineering", priority: null });
    expect(p2.items[0]?.mappingIssues).toEqual([
      { field: "status", raw: "Escalated to Engineering" },
      { field: "priority", raw: "P2" },
    ]);
    expect(p2.items[1]).toMatchObject({ status: "closed", rawStatus: "Resolved - Duplicate", priority: "normal" });
    expect(p2.items[1]?.mappingIssues).toEqual([{ field: "status", raw: "Resolved - Duplicate" }]);
    expect(f.unused()).toEqual([]);
    // A cursor can't redirect requests to another host.
    const evil = Buffer.from(JSON.stringify({ next: "https://evil.example/steal" })).toString("base64url");
    expect((await rejection(c.listUpdatedTickets(since, evil))).kind).toBe("invalid");
  });

  it("builds canonical events from CaseHistory, EmailMessage and CaseComment", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory(CASE);
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
      "assignee:null", // assignment rule → queue (the Text twin row is dropped)
      "comment:requester:public", // case Description is the opening message
      "comment:bot:public", // Automated Process user's auto-ack
      "assignee:005Hs00000Agnt1AAA",
      "status:open:Working",
      "comment:agent:internal", // unpublished CaseComment
      "status:pending:Waiting on Customer",
      "comment:agent:public", // outgoing EmailMessage
      "status:open:Working",
      "comment:requester:public", // incoming EmailMessage
      "priority:high",
      "comment:agent:public", // published CaseComment
      "status:closed:Closed",
      "status:open:Working", // reopen
      "comment:requester:public",
    ]);
    expect(h.ticket).toMatchObject({ status: "open", priority: "high", tags: [], ref: { displayKey: "#00001042" } });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      [`${CASE}:description`, "requester", true],
      ["00aHs00000Cmt01AAA", "bot", true],
      ["00aHs00000Cmt02AAA", "agent", false],
      ["02sHs00000Eml01AAA", "agent", true],
      ["02sHs00000Eml02AAA", "requester", true],
      ["00aHs00000Cmt03AAA", "agent", true],
      ["02sHs00000Eml03AAA", "requester", true],
    ]);
    expect(h.comments[0]?.bodyText).toBe(
      "Since the 2.14 upgrade our nightly invoice export stops at 80% with a timeout.\n\nThis blocks month-end close.",
    );
    expect(h.comments[6]?.bodyText).toBe("Still failing tonight — stopped at 81%.");
    expect(h.events[1]?.idempotencyKey).toBe("salesforce:northwind.my.salesforce.com:history:017Hs00000Hst02AAA");
    expect(h.events.find((e) => e.type === "comment" && e.author === "bot")?.idempotencyKey).toBe(
      "salesforce:northwind.my.salesforce.com:comment:00aHs00000Cmt01AAA",
    );
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    const again = await client(historyRoutes).c.getTicketWithHistory(CASE);
    expect(again.events.map((e) => e.idempotencyKey)).toEqual(h.events.map((e) => e.idempotencyKey));
  });

  it("counts configured integration users as bots", async () => {
    const h = await client(historyRoutes, { config: { botUserIds: ["005Hs00000Agnt1AAA"] } }).c.getTicketWithHistory(
      CASE,
    );
    expect(h.comments.find((x) => x.sourceId === "00aHs00000Cmt03AAA")?.authorRole).toBe("bot");
    expect(h.comments.find((x) => x.sourceId === "02sHs00000Eml01AAA")?.authorRole).toBe("bot");
  });

  it("end to end: FR met, next response breached after the reopen, resolution paused while waiting on customer", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory(CASE);
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T18:00:00Z"));
    // Created 09:00 at Medium (normal, 240 min); the bot ack at 09:05 doesn't count; agent email at 10:30.
    expect(metric(ev, "first_response")).toMatchObject({ state: "achieved", elapsedMs: 90 * 60_000 });
    const nr = metric(ev, "next_response");
    // Cycle 1: customer 13:00 → agent 14:10 (70 min). Cycle 2: customer 15:00, high = 120 min.
    expect(nr.cycles.map((x) => [x.state, x.elapsedMs])).toEqual([
      ["achieved", 70 * 60_000],
      ["breached", 180 * 60_000],
    ]);
    expect(nr.state).toBe("breached");
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-28T17:00:00.000Z");
    // 09:00–10:30 (90) + paused while pending + 13:00–14:15 (75) + closed + 15:00–18:00 (180).
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(345 * 60_000);
    expect(res.dueAt?.toISOString()).toBe("2026-09-29T12:15:00.000Z");
  });

  it("has no webhooks (CDC needs a streaming client), so every delivery is unsupported", async () => {
    const { c } = client([]);
    const req = { headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/webhooks/salesforce/conn_1" };
    expect(await c.handleWebhook(req, "secret")).toEqual({ ok: false, reason: "unsupported" });
    expect(await c.handleWebhook(req, null)).toEqual({ ok: false, reason: "unsupported" });
    expect(salesforce.supportsWebhooks).toBe(false);
  });

  it("maps 429 to rate_limited, the daily API limit (403 REQUEST_LIMIT_EXCEEDED) too", async () => {
    const r429 = client([
      tokenRoute,
      { method: "GET", url: /\/query\?/, status: 429, responseHeaders: { "Retry-After": "5" } },
    ]);
    const err = await rejection(r429.c.getTicketWithHistory(CASE));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(5000);

    const daily = client([
      tokenRoute,
      {
        method: "GET",
        url: /\/query\?/,
        status: 403,
        json: [{ message: "TotalRequests Limit exceeded.", errorCode: "REQUEST_LIMIT_EXCEEDED" }],
      },
    ]);
    expect((await rejection(daily.c.getTicketWithHistory(CASE))).kind).toBe("rate_limited");

    const tokenLimited = client([
      { method: "POST", url: `${BASE}/services/oauth2/token`, status: 429, responseHeaders: { "Retry-After": "7" } },
    ]);
    const tErr = await rejection(tokenLimited.c.testConnection());
    expect([tErr.kind, tErr.retryAfterMs]).toEqual(["rate_limited", 7000]);
  });

  it("fetches a new token once when the session expires", async () => {
    const orgQuery = q("SELECT Id, Name FROM Organization LIMIT 1");
    const { c, f, forms } = client([
      tokenRoute,
      { method: "GET", url: orgQuery, status: 401, json: [{ errorCode: "INVALID_SESSION_ID" }] },
      tokenRoute,
      {
        method: "GET",
        url: orgQuery,
        json: { done: true, records: [{ Id: "00DHs0000001nWzMAI", Name: "Northwind" }] },
      },
    ]);
    expect((await c.testConnection()).accountName).toBe("Northwind");
    expect(forms).toHaveLength(2);
    expect(f.unused()).toEqual([]);
  });

  it("writes internal/public CaseComments and patches priority and owner", async () => {
    const { c, f } = client([
      tokenRoute,
      {
        method: "POST",
        url: `${DATA}/sobjects/CaseComment`,
        headers: { authorization: AUTH },
        body: (b) => expect(b).toEqual({ ParentId: CASE, CommentBody: "Drafted by slai", IsPublished: false }),
        status: 201,
        json: { id: "00aHs00000Cmt04AAA", success: true, errors: [] },
      },
      {
        method: "POST",
        url: `${DATA}/sobjects/CaseComment`,
        body: (b) => expect(b).toEqual({ ParentId: CASE, CommentBody: "Fixed on our side.", IsPublished: true }),
        status: 201,
        json: { id: "00aHs00000Cmt05AAA", success: true, errors: [] },
      },
      {
        method: "PATCH",
        url: `${DATA}/sobjects/Case/${CASE}`,
        headers: { authorization: AUTH },
        body: (b) => expect(b).toEqual({ Priority: "High", OwnerId: "005Hs00000Agnt1AAA" }),
        status: 204,
      },
    ]);
    expect(await c.postInternalNote(CASE, "Drafted by slai")).toEqual({ commentSourceId: "00aHs00000Cmt04AAA" });
    expect(await c.postPublicReply(CASE, "Fixed on our side.")).toEqual({ commentSourceId: "00aHs00000Cmt05AAA" });
    await c.updateTicket(CASE, { priority: "high", assigneeSourceId: "005Hs00000Agnt1AAA" });
    expect(f.unused()).toEqual([]);

    expect(salesforce.write.tags).toBe(false);
    expect((await rejection(c.updateTicket(CASE, { addTags: ["vip"] }))).kind).toBe("unsupported");
    // Ids are interpolated into SOQL/paths, so anything that isn't an id is refused.
    expect((await rejection(c.getTicketWithHistory("x' OR Id != '"))).kind).toBe("invalid");
    expect((await rejection(c.updateTicket(CASE, { assigneeSourceId: "../Account" }))).kind).toBe("invalid");

    // The default picklist has no urgent value in a customer's own mapping: refuse, don't send garbage.
    const noUrgent = client([], {
      mapping: { status: salesforce.defaultMapping.status, priority: { High: "high", Medium: "normal", Low: "low" } },
    });
    expect((await rejection(noUrgent.c.updateTicket(CASE, { priority: "urgent" }))).kind).toBe("invalid");
  });
});
