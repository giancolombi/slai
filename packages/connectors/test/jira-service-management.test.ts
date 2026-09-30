import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { adfToText } from "../src/connectors/adf.js";
import { jiraServiceManagement as jsm } from "../src/connectors/jira-service-management.js";
import { toEngineEvents } from "../src/lib/events.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const SITE = "https://acme.atlassian.net";
const AUTH = `Basic ${Buffer.from("admin@acme.com:atl_tok").toString("base64")}`;

function client(routes: Route[], config: Record<string, unknown> = {}) {
  const f = fakeFetch(routes);
  const c = jsm.create({
    credentials: { siteUrl: `${SITE}/`, email: "admin@acme.com", apiToken: "atl_tok" },
    config,
    mapping: jsm.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: `${SITE}/rest/api/3/issue/10042?fields=summary,status,priority,reporter,assignee,labels,created,updated,project,description`,
    headers: { authorization: AUTH },
    fixture: "jira_service_management/issue-10042.json",
  },
  {
    method: "GET",
    url: `${SITE}/rest/api/3/issue/10042/changelog?startAt=0&maxResults=100`,
    headers: { authorization: AUTH },
    fixture: "jira_service_management/changelog-10042-page1.json",
  },
  {
    method: "GET",
    url: `${SITE}/rest/api/3/issue/10042/changelog?startAt=3&maxResults=100`,
    fixture: "jira_service_management/changelog-10042-page2.json",
  },
  {
    method: "GET",
    url: `${SITE}/rest/api/3/issue/10042/comment?startAt=0&maxResults=100&orderBy=created`,
    headers: { authorization: AUTH },
    fixture: "jira_service_management/comments-10042-page1.json",
  },
  {
    method: "GET",
    url: `${SITE}/rest/api/3/issue/10042/comment?startAt=3&maxResults=100&orderBy=created`,
    fixture: "jira_service_management/comments-10042-page2.json",
  },
];

const jwt = (claims: object, secret: string) => {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(claims);
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
};

describe("jira service management connector", () => {
  it("tests the connection", async () => {
    const { c } = client([
      {
        method: "GET",
        url: `${SITE}/rest/api/3/myself`,
        headers: { authorization: AUTH },
        json: { accountId: "5b10a2844c20165700ede21g", displayName: "Dana Whitfield", accountType: "atlassian" },
      },
    ]);
    expect(await c.testConnection()).toEqual({ accountName: "acme.atlassian.net", accountId: "acme.atlassian.net" });
    const bad = client([{ method: "GET", url: `${SITE}/rest/api/3/myself`, status: 401 }]);
    expect((await rejection(bad.c.testConnection())).kind).toBe("auth");
  });

  it("rejects a non-https site URL", () => {
    expect(
      jsm.credentialsSchema.safeParse({ siteUrl: "http://acme.atlassian.net", email: "a@b.co", apiToken: "x" }).success,
    ).toBe(false);
  });

  it("lists updated issues with JQL search and nextPageToken pagination", async () => {
    const since = new Date("2026-09-28T00:00:00Z");
    const jql = `project in (SUP,OPS) AND updated >= ${since.getTime()} ORDER BY updated ASC`;
    const fields = ["summary", "status", "priority", "reporter", "assignee", "labels", "created", "updated", "project"];
    const { c, f } = client(
      [
        {
          method: "POST",
          url: `${SITE}/rest/api/3/search/jql`,
          headers: { authorization: AUTH, "content-type": "application/json" },
          body: (b) => expect(b).toEqual({ jql, fields, maxResults: 100 }),
          fixture: "jira_service_management/search-page1.json",
        },
        {
          method: "POST",
          url: `${SITE}/rest/api/3/search/jql`,
          body: (b) => expect(b).toEqual({ jql, fields, maxResults: 100, nextPageToken: "CAEaAggB" }),
          fixture: "jira_service_management/search-page2.json",
        },
      ],
      { projectKeys: ["SUP", "OPS"] },
    );
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items[0]).toMatchObject({
      ref: { sourceId: "10042", displayKey: "SUP-42", url: `${SITE}/browse/SUP-42` },
      status: "open",
      rawStatus: "Waiting for support",
      priority: "urgent",
      requester: { sourceId: "qm:cust-1", email: "maya.chen@northwind.example" },
      assignee: { sourceId: "5b10a2844c20165700ede21g", name: "Dana Whitfield" },
      mappingIssues: [],
    });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // Unknown status falls back to its status category, unknown priority to null; both flagged.
    expect(p2.items[0]).toMatchObject({ status: "new", priority: null, rawStatus: "Triage", rawPriority: "P9" });
    expect(p2.items[0]?.mappingIssues).toEqual([
      { field: "status", raw: "Triage" },
      { field: "priority", raw: "P9" },
    ]);
    expect(f.unused()).toEqual([]);
  });

  it("builds canonical events from changelog + comments: pending, reopen, internal vs public, customer/agent/app", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory("10042");
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
      "created:open:high",
      "comment:requester:public",
      "comment:bot:public",
      "assignee:5b10a2844c20165700ede21g",
      "comment:agent:internal",
      "status:pending",
      "comment:agent:public",
      "status:open",
      "comment:requester:public",
      "status:solved",
      "comment:agent:public",
      "status:open",
      "comment:requester:public",
      "priority:urgent",
      "tags:enterprise,reopened,sso",
    ]);
    expect(h.events.find((e) => e.type === "status_changed")?.idempotencyKey).toBe(
      "jsm:acme.atlassian.net:changelog:20002:0",
    );
    expect(h.events.find((e) => e.type === "comment" && e.commentSourceId === "30002")?.idempotencyKey).toBe(
      "jsm:acme.atlassian.net:comment:30002",
    );
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      ["10042:description", "requester", true],
      ["30001", "bot", true],
      ["30002", "agent", false],
      ["30003", "agent", true],
      ["30004", "requester", true],
      ["30005", "agent", true],
      ["30006", "requester", true],
    ]);
    expect(h.comments[0]?.bodyText).toBe(
      "Since this morning our users get audience mismatch errors.\nAffected:\n• Finance\n• Ops",
    );
    expect(h.comments[3]?.bodyText).toBe("Hi @Maya Chen, could you send a SAML trace?");
    expect(h.ticket.status).toBe("open");
  });

  it("history keys are stable across fetches", async () => {
    const a = await client(historyRoutes).c.getTicketWithHistory("10042");
    const b = await client(historyRoutes).c.getTicketWithHistory("10042");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met, next response breached after reopen, resolution running with pending paused", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("10042");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-29T10:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(40 * 60_000); // automation reply did not count
    const nr = metric(ev, "next_response");
    expect(nr.cycles.map((x) => x.state)).toEqual(["achieved", "breached"]);
    expect(nr.cycles[0]?.elapsedMs).toBe(60 * 60_000);
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-29T09:00:00.000Z");
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(220 * 60_000);
    expect(ev.risk).toBe("breached");
  });

  it("verifies admin webhooks (X-Hub-Signature sha256) and OAuth dynamic webhooks (HS256 JWT)", async () => {
    const { c } = client([]);
    const secret = "jira_whsec";
    const body = JSON.stringify({
      timestamp: 1790672400000,
      webhookEvent: "comment_created",
      comment: { id: "30007" },
      issue: { id: "10042", key: "SUP-42", fields: {} },
    });
    const url = "https://api.slai.dev/webhooks/jsm/conn_1";
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(await c.handleWebhook({ headers: { "X-Hub-Signature": sig }, rawBody: body, url }, secret)).toEqual({
      ok: true,
      ticketSourceIds: ["10042"],
    });
    expect(await c.handleWebhook({ headers: { "X-Hub-Signature": sig }, rawBody: body, url }, "nope")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      await c.handleWebhook(
        { headers: { "X-Hub-Signature": sig }, rawBody: body.replace("10042", "10043"), url },
        secret,
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook({ headers: {}, rawBody: body, url }, secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook({ headers: { "X-Hub-Signature": sig }, rawBody: body, url }, null)).toEqual({
      ok: false,
      reason: "bad_signature",
    });

    const exp = Math.floor(Date.now() / 1000) + 300;
    const good = jwt({ iss: "client-id", exp }, secret);
    expect(await c.handleWebhook({ headers: { Authorization: `Bearer ${good}` }, rawBody: body, url }, secret)).toEqual(
      {
        ok: true,
        ticketSourceIds: ["10042"],
      },
    );
    const forged = jwt({ iss: "client-id", exp }, "other");
    expect(
      await c.handleWebhook({ headers: { Authorization: `Bearer ${forged}` }, rawBody: body, url }, secret),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const expired = jwt({ iss: "client-id", exp: Math.floor(Date.now() / 1000) - 60 }, secret);
    expect(
      await c.handleWebhook({ headers: { Authorization: `Bearer ${expired}` }, rawBody: body, url }, secret),
    ).toEqual({ ok: false, reason: "bad_signature" });

    const junk = "not json";
    const junkSig = `sha256=${createHmac("sha256", secret).update(junk).digest("hex")}`;
    expect(await c.handleWebhook({ headers: { "x-hub-signature": junkSig }, rawBody: junk, url }, secret)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { c } = client([
      { method: "GET", url: /\/rest\/api\/3\/issue\/10042\?/, status: 429, responseHeaders: { "Retry-After": "12" } },
    ]);
    const err = await rejection(c.getTicketWithHistory("10042"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(12_000);
  });

  it("writes internal notes, public replies, and updates", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${SITE}/rest/servicedeskapi/request/10042/comment`,
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: (b) => expect(b).toEqual({ body: "Drafted by slai", public: false }),
        json: { id: "30008", body: "Drafted by slai", public: false, created: { iso8601: "2026-09-29T10:00:00+0000" } },
      },
      {
        method: "POST",
        url: `${SITE}/rest/servicedeskapi/request/10042/comment`,
        body: (b) => expect(b).toEqual({ body: "Fixed!", public: true }),
        json: { id: "30009", body: "Fixed!", public: true },
      },
      {
        method: "PUT",
        url: `${SITE}/rest/api/3/issue/10042`,
        body: (b) =>
          expect(b).toEqual({ fields: { priority: { name: "Highest" } }, update: { labels: [{ add: "vip" }] } }),
      },
      {
        method: "PUT",
        url: `${SITE}/rest/api/3/issue/10042/assignee`,
        body: (b) => expect(b).toEqual({ accountId: "5b10a2844c20165700ede21g" }),
      },
    ]);
    expect(await c.postInternalNote("10042", "Drafted by slai")).toEqual({ commentSourceId: "30008" });
    expect(await c.postPublicReply("10042", "Fixed!")).toEqual({ commentSourceId: "30009" });
    await c.updateTicket("10042", {
      priority: "urgent",
      assigneeSourceId: "5b10a2844c20165700ede21g",
      addTags: ["vip"],
    });
    expect(f.unused()).toEqual([]);
  });

  it("converts ADF to text", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText("plain")).toBe("plain");
    expect(
      adfToText({
        type: "doc",
        content: [
          { type: "heading", content: [{ type: "text", text: "Title" }] },
          {
            type: "paragraph",
            content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }],
          },
        ],
      }),
    ).toBe("Title\na\nb");
  });
});
