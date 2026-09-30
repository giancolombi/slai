import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { github } from "../src/connectors/github.js";
import { toEngineEvents } from "../src/lib/events.js";
import { encodeCursor } from "../src/lib/paginate.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://api.github.com";
const REPO = `${BASE}/repos/acme-corp/helpdesk`;
const HEADERS = {
  authorization: "Bearer ghp_test",
  accept: "application/vnd.github+json",
  "x-github-api-version": "2026-03-10",
};

function client(routes: Route[]) {
  const f = fakeFetch(routes);
  const c = github.create({
    credentials: github.credentialsSchema.parse({ token: "ghp_test", owner: "acme-corp", repo: "helpdesk" }),
    config: {},
    mapping: github.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes: Route[] = [
  { method: "GET", url: `${REPO}/issues/42`, headers: HEADERS, fixture: "github/issue-42.json" },
  {
    method: "GET",
    url: `${REPO}/issues/42/timeline?per_page=100`,
    headers: HEADERS,
    fixture: "github/timeline-42-page1.json",
    responseHeaders: {
      Link: '<https://api.github.com/repositories/1180501/issues/42/timeline?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1180501/issues/42/timeline?per_page=100&page=2>; rel="last"',
    },
  },
  {
    method: "GET",
    url: `${BASE}/repositories/1180501/issues/42/timeline?per_page=100&page=2`,
    headers: HEADERS,
    fixture: "github/timeline-42-page2.json",
    responseHeaders: {
      Link: '<https://api.github.com/repositories/1180501/issues/42/timeline?per_page=100&page=1>; rel="prev", <https://api.github.com/repositories/1180501/issues/42/timeline?per_page=100&page=1>; rel="first"',
    },
  },
];

describe("github connector", () => {
  it("tests the connection with a bearer token and the pinned API version", async () => {
    const { c, f } = client([{ method: "GET", url: REPO, headers: HEADERS, fixture: "github/repo.json" }]);
    expect(await c.testConnection()).toEqual({ accountName: "acme-corp/helpdesk", accountId: "1180501" });
    expect(f.unused()).toEqual([]);
    const disabled = client([
      { method: "GET", url: REPO, json: { id: 1, full_name: "acme-corp/helpdesk", has_issues: false } },
    ]);
    expect((await rejection(disabled.c.testConnection())).kind).toBe("invalid");
    const bad = client([{ method: "GET", url: REPO, status: 401, json: { message: "Bad credentials" } }]);
    expect((await rejection(bad.c.testConnection())).kind).toBe("auth");
  });

  it("lists updated issues across Link pages, skips pull requests, maps labels, flags unmapped priority", async () => {
    const since = new Date("2026-09-28T00:00:00Z");
    const page2 =
      "https://api.github.com/repositories/1180501/issues?state=all&since=2026-09-28T00%3A00%3A00.000Z&sort=updated&direction=asc&per_page=100&page=2";
    const { c, f } = client([
      {
        method: "GET",
        url: `${REPO}/issues?state=all&since=2026-09-28T00:00:00.000Z&sort=updated&direction=asc&per_page=100`,
        headers: HEADERS,
        fixture: "github/issues-page1.json",
        responseHeaders: { Link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
      },
      { method: "GET", url: page2, headers: HEADERS, fixture: "github/issues-page2.json" },
    ]);
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.sourceId, t.status, t.rawStatus, t.priority])).toEqual([
      ["40", "closed", "closed:not_planned", null],
      ["42", "open", "open", "urgent"], // #43 is a pull request
    ]);
    expect(p1.items[1]).toMatchObject({
      ref: {
        displayKey: "acme-corp/helpdesk#42",
        url: "https://github.com/acme-corp/helpdesk/issues/42",
      },
      rawPriority: "priority: urgent",
      requester: { sourceId: "maya-chen" },
      assignee: { sourceId: "lee-okafor", name: "lee-okafor" },
      tags: ["bug", "priority: urgent"],
      mappingIssues: [],
    });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    // A status label while open wins over "open"; an unknown priority-looking label is flagged.
    expect(p2.items[0]).toMatchObject({ status: "on_hold", rawStatus: "status: on-hold", priority: null });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "priority", raw: "priority: critical" }]);
    expect(p2.items[1]).toMatchObject({ status: "open", priority: "high", rawPriority: "P1", mappingIssues: [] });
    expect(f.unused()).toEqual([]);
    // A cursor pointing off the API origin would leak the token: refuse it.
    const evil = encodeCursor({ u: "https://evil.example/steal" });
    expect((await rejection(c.listUpdatedTickets(since, evil))).kind).toBe("invalid");
  });

  it("flags the open/closed fallback when a customer mapping omits it", async () => {
    const f = fakeFetch([{ method: "GET", url: /\/issues\?/, fixture: "github/issues-page1.json" }]);
    const c = github.create({
      credentials: github.credentialsSchema.parse({ token: "ghp_test", owner: "acme-corp", repo: "helpdesk" }),
      config: {},
      mapping: { status: { open: "open", closed: "solved" }, priority: github.defaultMapping.priority },
      fetch: f.fetch,
    });
    const p = await c.listUpdatedTickets(new Date("2026-09-28T00:00:00Z"), null);
    expect(p.items[0]).toMatchObject({ status: "open", rawStatus: "closed:not_planned" });
    expect(p.items[0]?.mappingIssues).toEqual([{ field: "status", raw: "closed:not_planned" }]);
  });

  it("builds canonical events from the timeline: pending label, close/reopen, bot vs agent, priority, assignee", async () => {
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
    // GitHub has no internal comments: every comment is public (internal notes are unsupported).
    expect(summary).toEqual([
      "created:open:null",
      "tags:bug",
      "comment:requester:public", // the issue body is the opening message
      "comment:bot:public", // helpdesk-triage[bot], user.type Bot
      "priority:high",
      "tags:bug,priority: high",
      "assignee:dana-whitfield",
      "comment:agent:public", // MEMBER
      "status:pending:status: waiting-on-customer",
      "tags:bug,priority: high,status: waiting-on-customer",
      "comment:requester:public",
      "status:open:open",
      "tags:bug,priority: high",
      "comment:agent:public",
      "status:solved:closed",
      "status:open:open",
      "comment:requester:public",
      "priority:urgent",
      "tags:bug,priority: high,priority: urgent",
      "tags:bug,priority: urgent",
      "assignee:null",
      "assignee:lee-okafor",
    ]);
    expect(h.events[0]?.idempotencyKey).toBe("github:acme-corp/helpdesk:issue:42:created");
    expect(h.events[3]?.idempotencyKey).toBe("github:acme-corp/helpdesk:comment:5001");
    expect(h.events[4]?.idempotencyKey).toBe("github:acme-corp/helpdesk:event:9001:priority");
    expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.authorSourceId, x.public])).toEqual([
      ["issue-42", "requester", "maya-chen", true],
      ["5001", "bot", "helpdesk-triage[bot]", true],
      ["5002", "agent", "dana-whitfield", true],
      ["5003", "requester", "maya-chen", true],
      ["5004", "agent", "dana-whitfield", true],
      ["5005", "requester", "maya-chen", true],
    ]);
    expect(h.comments[0]?.bodyText).toBe(
      "Since this morning our order.updated webhooks fail with a 502.\n\nDelivery IDs attached below.",
    );
    expect(h.ticket).toMatchObject({ status: "open", priority: "urgent", assignee: { sourceId: "lee-okafor" } });
  });

  it("history keys are stable across fetches (webhook + poll dedupe)", async () => {
    const a = await client(historyRoutes).c.getTicketWithHistory("42");
    const b = await client(historyRoutes).c.getTicketWithHistory("42");
    expect(a.events.map((e) => e.idempotencyKey)).toEqual(b.events.map((e) => e.idempotencyKey));
  });

  it("end to end: FR met despite the bot, NR paused while pending, NR breached after reopen, resolution running", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory("42");
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T16:00:00Z"));
    // 09:00 → 09:40 (bot ack at 09:00:05 doesn't count); high = 60 min.
    expect(metric(ev, "first_response")).toMatchObject({ state: "achieved", elapsedMs: 40 * 60_000 });
    const nr = metric(ev, "next_response");
    // Cycle 1: customer replied at 11:00 while pending, clock ran 11:05 → 12:00.
    // Cycle 2: customer replied at 14:01 after reopen; urgent = 60 min; no reply by 16:00.
    expect(nr.cycles.map((x) => [x.state, x.elapsedMs])).toEqual([
      ["achieved", 55 * 60_000],
      ["breached", 119 * 60_000],
    ]);
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-09-28T15:01:00.000Z");
    const res = metric(ev, "resolution");
    // 09:00-09:41 (41) + 11:05-12:30 (85) + 14:00-16:00 (120) = 246 of urgent 480.
    expect(res).toMatchObject({ state: "running", elapsedMs: 246 * 60_000 });
    expect(res.dueAt?.toISOString()).toBe("2026-09-28T19:54:00.000Z");
    expect(ev.risk).toBe("breached");
  });

  it("verifies webhook signatures (X-Hub-Signature-256, HMAC-SHA256 hex over the raw body)", async () => {
    const { c } = client([]);
    const secret = "gh_whsec";
    const sign = (b: string, s = secret) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;
    const body = JSON.stringify({
      action: "labeled",
      issue: { number: 42, title: "Webhook deliveries fail", state: "open" },
      label: { name: "priority: urgent" },
      repository: { id: 1180501, full_name: "acme-corp/helpdesk" },
      sender: { login: "dana-whitfield" },
    });
    const req = (sig: string | undefined, rawBody = body, event = "issues") => ({
      headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": event, "X-GitHub-Delivery": "d-1" },
      rawBody,
      url: "https://api.slai.dev/webhooks/github/conn_1",
    });
    expect(await c.handleWebhook(req(sign(body)), secret)).toEqual({ ok: true, ticketSourceIds: ["42"] });
    expect(await c.handleWebhook(req(sign(body, "wrong")), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sign(body)), "wrong")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined), secret)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sign(body)), null)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(sign(body).replace("sha256=", "sha1=")), secret)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook(req(sign("not json"), "not json"), secret)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // issue_comment on an issue → the issue; on a pull request → ignored.
    const onIssue = JSON.stringify({
      action: "created",
      issue: { number: 42 },
      comment: { id: 5005 },
      repository: { full_name: "acme-corp/helpdesk" },
    });
    expect(await c.handleWebhook(req(sign(onIssue), onIssue, "issue_comment"), secret)).toEqual({
      ok: true,
      ticketSourceIds: ["42"],
    });
    const onPr = JSON.stringify({
      action: "created",
      issue: { number: 43, pull_request: { url: `${REPO}/pulls/43` } },
      comment: { id: 5100 },
      repository: { full_name: "acme-corp/helpdesk" },
    });
    expect(await c.handleWebhook(req(sign(onPr), onPr, "issue_comment"), secret)).toEqual({
      ok: true,
      ticketSourceIds: [],
    });
    // Org-level hook delivering another repository, and the setup ping: nothing to sync.
    const other = JSON.stringify({
      action: "opened",
      issue: { number: 7 },
      repository: { full_name: "acme-corp/web" },
    });
    expect(await c.handleWebhook(req(sign(other), other), secret)).toEqual({ ok: true, ticketSourceIds: [] });
    const ping = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    expect(await c.handleWebhook(req(sign(ping), ping, "ping"), secret)).toEqual({ ok: true, ticketSourceIds: [] });
    // Signed but not an issue payload.
    const junk = JSON.stringify({ action: "opened" });
    expect(await c.handleWebhook(req(sign(junk), junk), secret)).toEqual({ ok: false, reason: "malformed" });
    // Registry contract: no headers → bad_signature.
    expect(
      await c.handleWebhook(
        { headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/webhooks/x" },
        "secret",
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("maps 429 and GitHub's 403 rate limits to rate_limited; a plain 403 stays auth", async () => {
    const r429 = client([
      { method: "GET", url: `${REPO}/issues/42`, status: 429, responseHeaders: { "Retry-After": "30" } },
    ]);
    const e1 = await rejection(r429.c.getTicketWithHistory("42"));
    expect(e1.kind).toBe("rate_limited");
    expect(e1.retryAfterMs).toBe(30_000);
    const secondary = client([
      {
        method: "GET",
        url: `${REPO}/issues/42`,
        status: 403,
        responseHeaders: { "Retry-After": "60" },
        json: { message: "You have exceeded a secondary rate limit." },
      },
    ]);
    const e2 = await rejection(secondary.c.getTicketWithHistory("42"));
    expect(e2.kind).toBe("rate_limited");
    expect(e2.retryAfterMs).toBe(60_000);
    const primary = client([
      {
        method: "GET",
        url: `${REPO}/issues/42`,
        status: 403,
        responseHeaders: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "120" },
        json: { message: "API rate limit exceeded" },
      },
    ]);
    const e3 = await rejection(primary.c.getTicketWithHistory("42"));
    expect(e3.kind).toBe("rate_limited");
    expect(e3.retryAfterMs).toBe(120_000);
    const denied = client([
      { method: "GET", url: `${REPO}/issues/42`, status: 403, json: { message: "Resource not accessible" } },
    ]);
    expect((await rejection(denied.c.getTicketWithHistory("42"))).kind).toBe("auth");
  });

  it("writes public replies and label/assignee updates; internal notes are unsupported", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: `${REPO}/issues/42/comments`,
        headers: { ...HEADERS, "content-type": "application/json" },
        body: (b) => expect(b).toEqual({ body: "We rolled out a fix for EU deliveries." }),
        status: 201,
        fixture: "github/comment-created.json",
      },
      { method: "GET", url: `${REPO}/issues/42`, headers: HEADERS, fixture: "github/issue-42.json" },
      {
        method: "POST",
        url: `${REPO}/issues/42/labels`,
        headers: HEADERS,
        body: (b) => expect(b).toEqual({ labels: ["priority: high", "vip"] }),
        json: [{ name: "bug" }, { name: "priority: urgent" }, { name: "priority: high" }, { name: "vip" }],
      },
      {
        method: "DELETE",
        url: `${REPO}/issues/42/labels/priority%3A%20urgent`,
        headers: HEADERS,
        json: [{ name: "bug" }, { name: "priority: high" }, { name: "vip" }],
      },
      {
        method: "POST",
        url: `${REPO}/issues/42/assignees`,
        headers: HEADERS,
        body: (b) => expect(b).toEqual({ assignees: ["dana-whitfield"] }),
        status: 201,
        json: { number: 42, assignees: [{ login: "lee-okafor" }, { login: "dana-whitfield" }] },
      },
      {
        method: "POST",
        url: `${REPO}/issues/42/labels`,
        body: (b) => expect(b).toEqual({ labels: ["needs-repro"] }),
        json: [{ name: "needs-repro" }],
      },
    ]);
    expect(await c.postPublicReply("42", "We rolled out a fix for EU deliveries.")).toEqual({
      commentSourceId: "5006",
    });
    await c.updateTicket("42", { priority: "high", assigneeSourceId: "dana-whitfield", addTags: ["vip"] });
    await c.updateTicket("42", { addTags: ["needs-repro"] });
    expect(f.unused()).toEqual([]);
    expect((await rejection(c.postInternalNote("42", "Drafted by slai"))).kind).toBe("unsupported");
    expect(github.write.internalNote).toBe(false);
  });

  it("tolerates a priority label that vanished meanwhile, and refuses unmapped priorities", async () => {
    const { c, f } = client([
      { method: "GET", url: `${REPO}/issues/42`, fixture: "github/issue-42.json" },
      {
        method: "POST",
        url: `${REPO}/issues/42/labels`,
        body: (b) => expect(b).toEqual({ labels: ["priority: low"] }),
        json: [],
      },
      {
        method: "DELETE",
        url: `${REPO}/issues/42/labels/priority%3A%20urgent`,
        status: 404,
        json: { message: "Label does not exist" },
      },
    ]);
    await c.updateTicket("42", { priority: "low" });
    expect(f.unused()).toEqual([]);
    const narrow = github.create({
      credentials: github.credentialsSchema.parse({ token: "ghp_test", owner: "acme-corp", repo: "helpdesk" }),
      config: {},
      mapping: { status: github.defaultMapping.status, priority: { "priority: high": "high" } },
      fetch: fakeFetch([]).fetch,
    });
    expect((await rejection(narrow.updateTicket("42", { priority: "urgent" }))).kind).toBe("invalid");
    expect((await rejection(c.getTicketWithHistory("../x"))).kind).toBe("invalid");
  });

  it("supports GitHub Enterprise Server base URLs", async () => {
    const f = fakeFetch([
      {
        method: "GET",
        url: "https://github.acme.example/api/v3/repos/acme-corp/helpdesk",
        headers: HEADERS,
        fixture: "github/repo.json",
      },
    ]);
    const c = github.create({
      credentials: github.credentialsSchema.parse({
        token: "ghp_test",
        owner: "acme-corp",
        repo: "helpdesk",
        apiBaseUrl: "https://github.acme.example/api/v3/",
      }),
      config: {},
      mapping: github.defaultMapping,
      fetch: f.fetch,
    });
    expect((await c.testConnection()).accountName).toBe("acme-corp/helpdesk");
  });
});
