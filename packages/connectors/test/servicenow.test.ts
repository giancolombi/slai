import { evaluateTicket } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { servicenow } from "../src/connectors/servicenow.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { FieldMapping } from "../src/types.js";
import { fakeFetch, type Route, rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const BASE = "https://acme.service-now.example";
const AUTH = `Basic ${Buffer.from("slai.integration:pw", "utf8").toString("base64")}`;
const INC = "9d385017c611228701d22104cc95c371";
const DANA = "46d44a23a9fe19810012d100cca80666";
const RAW = { sysparm_display_value: "false", sysparm_exclude_reference_link: "true" };
const INCIDENT_FIELDS =
  "sys_id,number,short_description,description,state,hold_reason,priority,caller_id,caller_id.user_name,caller_id.name,caller_id.email,company,company.name,assigned_to,assigned_to.name,assignment_group,contact_type,sys_created_on,sys_created_by,sys_updated_on";

const url = (path: string, q: Record<string, string | number> = {}) =>
  `${BASE}${path}?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`;

function client(
  routes: Route[],
  opts: { config?: Record<string, unknown>; credentials?: Record<string, unknown>; mapping?: FieldMapping } = {},
) {
  const f = fakeFetch(routes);
  const c = servicenow.create({
    credentials: servicenow.credentialsSchema.parse(
      opts.credentials ?? { instanceUrl: `${BASE}/`, username: "slai.integration", password: "pw" },
    ),
    config: opts.config ?? {},
    mapping: opts.mapping ?? servicenow.defaultMapping,
    fetch: f.fetch,
  });
  return { c, f };
}

const historyRoutes: Route[] = [
  {
    method: "GET",
    url: url(`/api/now/table/incident/${INC}`, { ...RAW, sysparm_fields: INCIDENT_FIELDS }),
    headers: { authorization: AUTH },
    fixture: "servicenow/incident-0010042.json",
  },
  {
    method: "GET",
    url: url("/api/now/table/sys_audit", {
      ...RAW,
      sysparm_query: `tablename=incident^documentkey=${INC}^fieldnameINstate,hold_reason,priority,assigned_to^ORDERBYsys_created_on`,
      sysparm_fields: "sys_id,fieldname,oldvalue,newvalue,sys_created_on,sys_created_by,record_checkpoint",
      sysparm_limit: 1000,
      sysparm_offset: 0,
    }),
    headers: { authorization: AUTH },
    fixture: "servicenow/audit-0010042.json",
  },
  {
    method: "GET",
    url: url("/api/now/table/sys_journal_field", {
      ...RAW,
      sysparm_query: `name=incident^element_id=${INC}^elementINcomments,work_notes^ORDERBYsys_created_on`,
      sysparm_fields: "sys_id,element,value,sys_created_on,sys_created_by",
      sysparm_limit: 1000,
      sysparm_offset: 0,
    }),
    fixture: "servicenow/journal-0010042.json",
  },
];

describe("servicenow connector", () => {
  it("tests the connection with Basic auth", async () => {
    const { c } = client([
      {
        method: "GET",
        url: url("/api/now/table/incident", { ...RAW, sysparm_fields: "sys_id", sysparm_limit: 1 }),
        headers: { authorization: AUTH },
        json: { result: [{ sys_id: INC }] },
      },
    ]);
    expect(await c.testConnection()).toEqual({
      accountName: "acme.service-now.example",
      accountId: "acme.service-now.example",
    });
  });

  it("exchanges OAuth client credentials once and sends the bearer token", async () => {
    const f = fakeFetch([
      {
        method: "POST",
        url: `${BASE}/oauth_token.do`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        json: { access_token: "sn_at_1", token_type: "Bearer", expires_in: 1799, scope: "useraccount" },
      },
      {
        method: "GET",
        url: url("/api/now/table/incident", { ...RAW, sysparm_fields: "sys_id", sysparm_limit: 1 }),
        headers: { authorization: "Bearer sn_at_1" },
        json: { result: [] },
        repeat: true,
      },
    ]);
    const forms: string[] = [];
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      if (init?.body instanceof URLSearchParams) forms.push(init.body.toString());
      return f.fetch(input, init);
    }) as typeof fetch;
    const c = servicenow.create({
      credentials: servicenow.credentialsSchema.parse({ instanceUrl: BASE, clientId: "cid", clientSecret: "csecret" }),
      config: {},
      mapping: servicenow.defaultMapping,
      fetch: spy,
    });
    await c.testConnection();
    await c.testConnection(); // token cached in the closure
    expect(forms).toEqual(["grant_type=client_credentials&client_id=cid&client_secret=csecret"]);
    expect(f.calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("maps a rejected OAuth client to kind auth", async () => {
    const { c } = client([{ method: "POST", url: `${BASE}/oauth_token.do`, status: 401, json: { error: "x" } }], {
      credentials: { instanceUrl: BASE, clientId: "cid", clientSecret: "bad" },
    });
    expect((await rejection(c.testConnection())).kind).toBe("auth");
  });

  it("keeps an object credentials schema whose shape covers every form field", () => {
    const shape = (servicenow.credentialsSchema as unknown as { shape: Record<string, unknown> }).shape;
    for (const field of servicenow.credentialFields) expect(Object.keys(shape)).toContain(field.key);
  });

  it("validates credentials: needs one complete auth method", () => {
    const parse = (v: unknown) => servicenow.credentialsSchema.safeParse(v).success;
    expect(parse({ instanceUrl: BASE, username: "u", password: "p" })).toBe(true);
    expect(parse({ instanceUrl: BASE, accessToken: "t" })).toBe(true);
    expect(parse({ instanceUrl: BASE, clientId: "c", clientSecret: "s" })).toBe(true);
    expect(parse({ instanceUrl: BASE })).toBe(false);
    expect(parse({ instanceUrl: BASE, username: "u" })).toBe(false);
    expect(parse({ instanceUrl: BASE, clientId: "c" })).toBe(false);
    expect(parse({ instanceUrl: "http://acme.service-now.example", accessToken: "t" })).toBe(false);
  });

  it("lists updated incidents by keyset pages and flags an unmapped hold reason", async () => {
    const list = (since: string, offset: number) =>
      url("/api/now/table/incident", {
        ...RAW,
        sysparm_query: `sys_updated_on>=${since}^ORDERBYsys_updated_on^ORDERBYsys_id`,
        sysparm_fields: INCIDENT_FIELDS,
        sysparm_limit: 2,
        sysparm_offset: offset,
      });
    const { c, f } = client(
      [
        {
          method: "GET",
          url: list("2026-09-28 00:00:00", 0),
          headers: { authorization: AUTH },
          fixture: "servicenow/incidents-page1.json",
        },
        // Re-anchored on the last row's second, skipping the one row already seen there.
        { method: "GET", url: list("2026-09-28 10:31:00", 1), fixture: "servicenow/incidents-page2.json" },
      ],
      { config: { pageSize: 2 } },
    );
    const since = new Date("2026-09-28T00:00:00.250Z");
    const p1 = await c.listUpdatedTickets(since, null);
    expect(p1.items.map((t) => [t.ref.displayKey, t.status, t.rawStatus, t.priority])).toEqual([
      ["INC0010041", "closed", "7", "low"],
      ["INC0010042", "pending", "3:1", "normal"],
    ]);
    expect(p1.items[0]).toMatchObject({ assignee: null, requester: { orgSourceId: null, orgName: null } });
    expect(p1.items[1]).toMatchObject({
      ref: { sourceId: INC, url: `${BASE}/incident.do?sys_id=${INC}` },
      requester: { email: "liam.okafor@bluepeak.example", name: "Liam Okafor", orgName: "Bluepeak Logistics" },
      assignee: { sourceId: DANA, name: "Dana Reyes" },
      channel: "self-service",
      tags: [],
      updatedAt: new Date("2026-09-28T10:31:00Z"),
      mappingIssues: [],
    });
    const p2 = await c.listUpdatedTickets(since, p1.nextCursor);
    expect(p2.nextCursor).toBeNull();
    expect(p2.items[0]).toMatchObject({ status: "open", rawStatus: "3:7", priority: "high" });
    expect(p2.items[0]?.mappingIssues).toEqual([{ field: "status", raw: "3:7" }]);
    expect(f.unused()).toEqual([]);
    expect((await rejection(c.listUpdatedTickets(since, "garbage!"))).kind).toBe("invalid");
  });

  it("builds canonical events from sys_audit + journal: pending, reopen, internal vs public, system bot", async () => {
    const { c, f } = client(historyRoutes);
    const h = await c.getTicketWithHistory(INC);
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
      "created:new:normal", // insert audits (state 1, priority 3) collapse into created
      "comment:requester:public", // description, opened by the caller
      "comment:bot:public", // "system" auto-acknowledgement
      `assignee:${DANA}`,
      "status:open:2",
      "comment:agent:internal", // work_notes
      "comment:agent:public",
      "status:pending:3:1", // On Hold + Awaiting Caller in one transaction
      "comment:requester:public",
      "status:open:2", // caller replied; system set In Progress and cleared the hold reason
      "priority:high",
      "comment:agent:public",
      "status:solved:6",
      "comment:requester:public",
      "status:open:2", // reopened
    ]);
    expect(h.ticket).toMatchObject({
      status: "open",
      rawStatus: "2",
      priority: "high",
      ref: { displayKey: "INC0010042" },
    });
    expect(h.comments.map((x) => [x.sourceId, x.authorRole, x.public])).toEqual([
      [`${INC}:description`, "requester", true],
      ["b0020001c611228701d22104cc950001", "bot", true],
      ["b0020001c611228701d22104cc950002", "agent", false],
      ["b0020001c611228701d22104cc950003", "agent", true],
      ["b0020001c611228701d22104cc950004", "requester", true],
      ["b0020001c611228701d22104cc950005", "agent", true],
      ["b0020001c611228701d22104cc950006", "requester", true],
    ]);
    expect(h.comments[3]).toMatchObject({
      authorName: "dana.reyes",
      authorSourceId: null,
      bodyText: "Hi Liam, can you confirm the webhook endpoint URL and whether it responds within 10 seconds?",
    });
    expect(h.comments[4]?.authorSourceId).toBe("62826bf03710200044e0bfc8bcbe5df1");
    expect(h.events.find((e) => e.type === "status_changed")?.idempotencyKey).toBe(
      "servicenow:acme.service-now.example:audit:a0010001c611228701d22104cc950004",
    );
    expect(h.events.filter((e) => e.type === "comment")[1]?.idempotencyKey).toBe(
      "servicenow:acme.service-now.example:journal:b0020001c611228701d22104cc950001",
    );
  });

  it("treats configured integration users as bots", async () => {
    const { c } = client(historyRoutes, { config: { botUserNames: ["Dana.Reyes"] } });
    const h = await c.getTicketWithHistory(INC);
    expect(h.comments.filter((x) => x.authorRole === "agent")).toEqual([]);
  });

  it("end to end: FR met, next response breached then re-running after reopen, resolution paused while pending", async () => {
    const h = await client(historyRoutes).c.getTicketWithHistory(INC);
    const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), new Date("2026-09-28T18:00:00Z"));
    // 09:00 → 10:30 first public agent reply (the 09:00:05 bot ack doesn't count).
    expect(metric(ev, "first_response")).toMatchObject({ state: "achieved", elapsedMs: 90 * 60_000 });
    const nr = metric(ev, "next_response");
    // Cycle 1: caller replied 13:00 while pending → clock from 13:00:30 to 15:58 = 177.5 min > 120 (high).
    expect(nr.cycles[0]).toMatchObject({ state: "breached", elapsedMs: 177.5 * 60_000 });
    expect(nr.cycles[0]?.breachAt?.toISOString()).toBe("2026-09-28T15:00:30.000Z");
    // Cycle 2: caller wrote 17:00 on the solved incident; the reopen restarts it from 17:00.
    expect(nr).toMatchObject({ state: "running", elapsedMs: 60 * 60_000, breachCount: 1 });
    expect(nr.dueAt?.toISOString()).toBe("2026-09-28T19:00:00.000Z");
    // Resolution: 09:00–10:31 (91) + 13:00:30–16:00 (179.5) + 17:00:10–18:00 (59m50s).
    const res = metric(ev, "resolution");
    expect(res).toMatchObject({ state: "running", elapsedMs: 19_820_000 });
    expect(res.dueAt?.toISOString()).toBe("2026-09-29T12:29:40.000Z");
  });

  it("verifies the shared-secret webhook header", async () => {
    const { c } = client([]);
    const body = JSON.stringify({ sys_id: INC, number: "INC0010042", table: "incident" });
    const req = (s?: string) => ({
      headers: { "X-Slai-Webhook-Secret": s, "Content-Type": "application/json" },
      rawBody: body,
      url: "https://api.slai.dev/webhooks/servicenow/conn_1",
    });
    expect(await c.handleWebhook(req("sn_secret"), "sn_secret")).toEqual({ ok: true, ticketSourceIds: [INC] });
    expect(await c.handleWebhook(req("sn_secret"), "other")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req(undefined), "sn_secret")).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook(req("sn_secret"), null)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await c.handleWebhook({ ...req("sn_secret"), rawBody: "not json" }, "sn_secret")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await c.handleWebhook({ ...req("sn_secret"), rawBody: '{"number":"INC0010042"}' }, "sn_secret")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await c.handleWebhook(
        { headers: {}, rawBody: '{"ticket_id":"1"}', url: "https://api.slai.dev/webhooks/x" },
        "secret",
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("maps 429 to rate_limited", async () => {
    const { c } = client([
      { method: "GET", url: /table\/incident\//, status: 429, responseHeaders: { "Retry-After": "5" } },
    ]);
    const err = await rejection(c.getTicketWithHistory(INC));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(5000);
  });

  it("writes work notes, comments, impact/urgency and assignee; tags unsupported", async () => {
    const patchUrl = url(`/api/now/table/incident/${INC}`, { sysparm_fields: "sys_id" });
    const ok = { result: { sys_id: INC } };
    const { c, f } = client([
      {
        method: "PATCH",
        url: patchUrl,
        headers: { authorization: AUTH },
        body: (b) => expect(b).toEqual({ work_notes: "Drafted by slai" }),
        json: ok,
      },
      {
        method: "PATCH",
        url: patchUrl,
        body: (b) => expect(b).toEqual({ comments: "Fixed on our side." }),
        json: ok,
      },
      {
        method: "PATCH",
        url: patchUrl,
        // high → raw priority "2" → impact 1 × urgency 2 in the out-of-box lookup.
        body: (b) => expect(b).toEqual({ impact: "1", urgency: "2", assigned_to: DANA }),
        json: ok,
      },
      {
        method: "PATCH",
        url: patchUrl,
        // low → first raw value mapped to low ("4") → impact 2 × urgency 3.
        body: (b) => expect(b).toEqual({ impact: "2", urgency: "3" }),
        json: ok,
      },
    ]);
    expect(await c.postInternalNote(INC, "Drafted by slai")).toEqual({ commentSourceId: null });
    expect(await c.postPublicReply(INC, "Fixed on our side.")).toEqual({ commentSourceId: null });
    await c.updateTicket(INC, { priority: "high", assigneeSourceId: DANA });
    await c.updateTicket(INC, { priority: "low" });
    expect(f.unused()).toEqual([]);
    expect((await rejection(c.updateTicket(INC, { addTags: ["vip"] }))).kind).toBe("unsupported");
    expect(servicenow.write.tags).toBe(false);
  });

  it("refuses a priority with no mapped raw value", async () => {
    const mapping: FieldMapping = { ...servicenow.defaultMapping, priority: { "2": "high", "3": "normal" } };
    const { c, f } = client([], { mapping });
    expect((await rejection(c.updateTicket(INC, { priority: "urgent" }))).kind).toBe("invalid");
    expect(f.calls).toEqual([]);
  });
});
