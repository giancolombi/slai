import { createHmac } from "node:crypto";
import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import {
  COMMENT_CREATE,
  COMMENTS_PAGE_QUERY,
  HISTORY_PAGE_QUERY,
  ISSUE_LABELS_QUERY,
  ISSUE_QUERY,
  ISSUE_UPDATE,
  ISSUES_QUERY,
  linear,
  VIEWER_QUERY,
} from "../src/connectors/linear.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { FieldMapping } from "../src/types.js";
import { fakeFetch, fixture, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const API = "https://api.linear.app/graphql";
const KEY = "lin_api_test123";
const ISSUE = "c0a8e1f4-6b2d-4e9a-9f31-7d5e2b8a4c10";
const MARCO = "3f6a1c2e-9d84-4b7a-a1e5-0c2d9b7f8e11";

function client(routes: Route[], config: Record<string, unknown> = {}, mapping: FieldMapping = linear.defaultMapping) {
  const f = fakeFetch(routes);
  const c = linear.create({ credentials: { apiKey: KEY }, config, mapping, fetch: f.fetch });
  return { c, f };
}

// biome-ignore lint/suspicious/noExplicitAny: request bodies are free-form JSON
const gql = (query: string, variables: Record<string, unknown>) => (b: any) => {
  expect(b.query).toBe(query);
  expect(b.variables).toEqual(variables);
};

const historyRoutes: Route[] = [
  {
    method: "POST",
    url: API,
    headers: { authorization: KEY },
    body: gql(ISSUE_QUERY, { id: ISSUE }),
    fixture: "linear/issue-142.json",
  },
  {
    method: "POST",
    url: API,
    headers: { authorization: KEY },
    body: gql(HISTORY_PAGE_QUERY, { id: ISSUE, after: "aGlzdG9yeS1wYWdlLTI" }),
    fixture: "linear/history-142-page2.json",
  },
];

describe("linear connector", () => {
  it("tests the connection with the raw API key (no Bearer)", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: API,
        headers: { authorization: KEY, "content-type": "application/json" },
        body: gql(VIEWER_QUERY, {}),
        fixture: "linear/viewer.json",
      },
    ]);
    expect(await c.testConnection()).toEqual({
      accountName: "Northwind Support",
      accountId: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a99",
    });
    expect(f.unused()).toEqual([]);
  });

  it("lists updated issues page by page; status by name, then by type; flags only when neither maps", async () => {
    // A customer mapping that names some states and some types but not "type:started".
    const mapping: FieldMapping = {
      status: { "In Progress": "open", "type:triage": "new", "type:completed": "solved" },
      priority: linear.defaultMapping.priority,
    };
    const filter = { updatedAt: { gte: "2026-09-28T00:00:00.000Z" }, team: { key: { eq: "ESC" } } };
    const { c, f } = client(
      [
        {
          method: "POST",
          url: API,
          headers: { authorization: KEY },
          body: gql(ISSUES_QUERY, { filter, first: 2, after: null }),
          fixture: "linear/issues-page1.json",
        },
        {
          method: "POST",
          url: API,
          body: gql(ISSUES_QUERY, { filter, first: 2, after: "aXNzdWVzLXBhZ2UtMg" }),
          fixture: "linear/issues-page2.json",
        },
      ],
      { teamKey: "ESC", pageSize: 2 },
      mapping,
    );
    const since = new Date("2026-09-28T00:00:00Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.rawStatus, t.priority, t.rawPriority])).toEqual([
      ["ESC-139", "new", "Triage", "normal", "3"], // by type
      ["ESC-142", "open", "In Progress", "high", "2"], // by name
    ]);
    expect(p1.items[1]).toMatchObject({
      ref: { sourceId: ISSUE, url: "https://linear.app/northwind/issue/ESC-142" },
      requester: { name: "Priya Raman", email: "priya.raman@harborline.example", orgName: "Harborline Freight" },
      assignee: { sourceId: MARCO, name: "Marco Bellini" },
      tags: ["customer-impact"],
      channel: "slack",
      mappingIssues: [],
    });
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    expect(p2.items[0]).toMatchObject({ status: "open", rawStatus: "In Review", priority: "urgent" });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "status", raw: "In Review" }]);
    expect(f.unused()).toEqual([]);
  });

  it("the default mapping maps a custom state by name and every standard type", async () => {
    const { c } = client([{ method: "POST", url: API, fixture: "linear/issues-page2.json" }]);
    const [t] = (await c.listUpdatedTickets(new Date("2026-09-28T00:00:00Z"), null)).items;
    expect(t).toMatchObject({ status: "open", rawStatus: "In Review", mappingIssues: [] });
  });

  it("builds canonical events from history (2 pages) + comments: pending, reopen, requester vs internal, bot", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory(ISSUE);
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
      "comment:requester:public", // description by the external (Slack) requester
      `assignee:${MARCO}`,
      "comment:agent:internal", // workspace member: always an internal note
      "status:open:In Progress",
      "priority:high",
      "tags:customer-impact",
      "comment:bot:internal", // GitHub integration (botActor)
      "status:pending:Waiting on customer", // custom state name → pending (pause)
      "comment:requester:public", // externalUser
      "status:open:In Progress",
      "status:solved:Done",
      "comment:requester:public", // member's comment that is the source of a Customer Need
      "status:open:In Progress", // reopen
    ]);
    expect(h.ticket).toMatchObject({
      status: "open",
      priority: "high",
      tags: ["customer-impact"],
      ref: { displayKey: "ESC-142" },
    });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public, x.authorName])).toEqual([
      [`${ISSUE}:description`, "requester", true, "Priya Raman"],
      ["d1000000-0000-4000-8000-000000000001", "agent", false, "Marco Bellini"],
      ["d2000000-0000-4000-8000-000000000002", "bot", false, "GitHub"],
      ["d3000000-0000-4000-8000-000000000003", "requester", true, "Priya Raman"],
      ["d4000000-0000-4000-8000-000000000004", "requester", true, "Lena Hoffmann"],
    ]);
    expect(h.comments[2]?.bodyText).toBe(
      "Pull request opened: **fix(webhooks): isolate retry queues per endpoint** (#4821)",
    );
    const keys = h.events.map((e) => e.idempotencyKey);
    expect(keys).toContain("linear:northwind:comment:d3000000-0000-4000-8000-000000000003");
    expect(keys).toContain("linear:northwind:history:a1000007-0000-4000-8000-000000000007:state");
    expect(keys[0]).toBe(`linear:northwind:issue:${ISSUE}:created`);
  });

  it("follows comment pages too", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: API,
        json: {
          data: {
            organization: { urlKey: "northwind" },
            issue: {
              ...fixture("linear/issue-142.json").data.issue,
              history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "Yy0y" } },
            },
          },
        },
      },
      {
        method: "POST",
        url: API,
        body: gql(COMMENTS_PAGE_QUERY, { id: ISSUE, after: "Yy0y" }),
        json: {
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: "d9",
                    body: "late",
                    createdAt: "2026-09-28T15:00:00.000Z",
                    user: null,
                    botActor: null,
                    externalUser: { id: "x", name: "Priya Raman", email: null },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ]);
    const h = await c.getTicketWithHistory(ISSUE);
    expect(h.comments.map((x) => x.sourceId)).toEqual([`${ISSUE}:description`, "d9"]);
    expect(f.unused()).toEqual([]);
  });

  it("end to end: FR breached at solve (no customer-facing replies in Linear), resolution paused while pending", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory(ISSUE);
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T16:00:00Z"));
    // No public agent reply ever: first response runs 09:00 → solve at 13:00 against high (60 min).
    const fr = metric(ev, "first_response");
    expect(fr).toMatchObject({ state: "breached", elapsedMs: 240 * 60_000 });
    expect(fr.cycles[0]?.breachAt?.toISOString()).toBe("2026-09-28T10:00:00.000Z");
    // Next response never starts: it needs a first response first.
    expect(metric(ev, "next_response").state).toBe("not_applicable");
    // Resolution: 09:00–11:00 (120) + 12:05–13:00 (55) + reopen 14:05–16:00 (115) = 290 min of 1440.
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(290 * 60_000);
    expect(res.dueAt?.toISOString()).toBe("2026-09-29T11:10:00.000Z");
    expect(ev.status).toBe("open");
  });

  it("verifies webhook signatures (Linear-Signature, HMAC-SHA256 hex) and the timestamp window", async () => {
    const { c } = client([]);
    const bodyFor = (o: Record<string, unknown>) =>
      JSON.stringify({
        action: "create",
        createdAt: "2026-09-28T12:00:00.000Z",
        organizationId: "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a99",
        webhookId: "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f",
        webhookTimestamp: Date.now(),
        ...o,
      });
    const sign = (b: string, secret = "lin_wh_secret") => createHmac("sha256", secret).update(b).digest("hex");
    const req = (rawBody: string, s?: string) => ({
      headers: { "Linear-Signature": s, "Linear-Event": "Comment", "Linear-Delivery": "d-1" },
      rawBody,
      url: "https://api.slai.dev/webhooks/linear/conn_1",
    });
    const comment = bodyFor({ type: "Comment", data: { id: "d3", issueId: ISSUE, body: "hi" } });
    expect(await c.handleWebhook(req(comment, sign(comment)), "lin_wh_secret")).toEqual({
      ok: true,
      ticketSourceIds: [ISSUE],
    });
    const issue = bodyFor({ type: "Issue", action: "update", data: { id: ISSUE, title: "x" } });
    expect(await c.handleWebhook(req(issue, sign(issue)), "lin_wh_secret")).toEqual({
      ok: true,
      ticketSourceIds: [ISSUE],
    });
    expect(await c.handleWebhook(req(comment, sign(comment)), "other")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(comment, sign(comment, "other")), "lin_wh_secret")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await c.handleWebhook(req(comment), "lin_wh_secret")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(comment, sign(comment)), null)).toEqual({ ok: false, reason: "bad_signature" });
    // Replay: correctly signed but older than 60 s.
    const stale = bodyFor({ type: "Issue", data: { id: ISSUE }, webhookTimestamp: Date.now() - 61_000 });
    expect(await c.handleWebhook(req(stale, sign(stale)), "lin_wh_secret")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const bad = "not json";
    expect(await c.handleWebhook(req(bad, sign(bad)), "lin_wh_secret")).toEqual({ ok: false, reason: "malformed" });
  });

  it("maps 429 with Retry-After to rate_limited", async () => {
    const { c } = client([{ method: "POST", url: API, status: 429, responseHeaders: { "Retry-After": "7" } }]);
    const err = await rejection(c.getTicketWithHistory(ISSUE));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(7000);
  });

  it("maps Linear's 400 RATELIMITED to rate_limited using the reset header", async () => {
    const reset = Date.now() + 30_000;
    const { c } = client([
      {
        method: "POST",
        url: API,
        status: 400,
        fixture: "linear/ratelimited.json",
        responseHeaders: { "X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": String(reset) },
      },
    ]);
    const err = await rejection(c.listUpdatedTickets(new Date("2026-09-28T00:00:00Z"), null));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("maps GraphQL errors in a 200 response", async () => {
    const { c } = client([
      {
        method: "POST",
        url: API,
        json: { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] },
      },
      {
        method: "POST",
        url: API,
        json: { data: null, errors: [{ message: "Entity not found: Issue", extensions: { code: "INVALID_INPUT" } }] },
      },
    ]);
    expect((await rejection(c.testConnection())).kind).toBe("auth");
    expect((await rejection(c.getTicketWithHistory("ESC-999"))).kind).toBe("not_found");
  });

  it("writes internal notes and issue updates; public replies are unsupported", async () => {
    const { c, f } = client([
      {
        method: "POST",
        url: API,
        headers: { authorization: KEY },
        body: gql(COMMENT_CREATE, { input: { issueId: ISSUE, body: "Drafted by slai" } }),
        json: { data: { commentCreate: { success: true, comment: { id: "d5000000-0000-4000-8000-000000000005" } } } },
      },
      {
        method: "POST",
        url: API,
        body: gql(ISSUE_LABELS_QUERY, { id: ISSUE, names: ["customer-impact", "sev2"] }),
        json: {
          data: {
            issue: { team: { id: "5d1e7a9c-2b4f-4c6d-8e0a-1b3c5d7e9f44" } },
            issueLabels: {
              nodes: [
                { id: "lbl-other-team", name: "customer-impact", team: { id: "another-team" } },
                { id: "lbl-esc", name: "customer-impact", team: { id: "5d1e7a9c-2b4f-4c6d-8e0a-1b3c5d7e9f44" } },
                { id: "lbl-workspace", name: "sev2", team: null },
              ],
            },
          },
        },
      },
      {
        method: "POST",
        url: API,
        body: gql(ISSUE_UPDATE, {
          id: ISSUE,
          input: { priority: 2, assigneeId: MARCO, addedLabelIds: ["lbl-esc", "lbl-workspace"] },
        }),
        json: { data: { issueUpdate: { success: true } } },
      },
      {
        method: "POST",
        url: API,
        body: gql(ISSUE_LABELS_QUERY, { id: ISSUE, names: ["nope"] }),
        json: { data: { issue: { team: { id: "t" } }, issueLabels: { nodes: [] } } },
      },
    ]);
    expect(await c.postInternalNote(ISSUE, "Drafted by slai")).toEqual({
      commentSourceId: "d5000000-0000-4000-8000-000000000005",
    });
    await c.updateTicket(ISSUE, { priority: "high", assigneeSourceId: MARCO, addTags: ["customer-impact", "sev2"] });
    // Unknown label names are refused rather than silently dropped.
    expect((await rejection(c.updateTicket(ISSUE, { addTags: ["nope"] }))).kind).toBe("invalid");
    expect(f.unused()).toEqual([]);
    expect((await rejection(c.postPublicReply(ISSUE, "hi"))).kind).toBe("unsupported");
    expect(linear.write.publicReply).toBe(false);
    // A customer mapping with no raw value for "urgent": refuse rather than send garbage.
    const noUrgent = client([], {}, { status: linear.defaultMapping.status, priority: { "2": "high", "3": "normal" } });
    expect((await rejection(noUrgent.c.updateTicket(ISSUE, { priority: "urgent" }))).kind).toBe("invalid");
  });
});
