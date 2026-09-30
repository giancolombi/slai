/**
 * ServiceNow connector (ITSM incident table).
 *
 * API docs (verified 2026-09):
 * - Table API (GET/PATCH /api/now/table/{table}, sysparm_query, sysparm_fields,
 *   sysparm_display_value, sysparm_exclude_reference_link, sysparm_limit,
 *   sysparm_offset, Link header rel="next"):
 *   https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html
 * - Encoded query syntax (ORDERBY, IN, ^):
 *   https://www.servicenow.com/docs/bundle/zurich-platform-user-interface/page/use/using-lists/concept/c_EncodedQueryStrings.html
 * - Inbound OAuth (POST /oauth_token.do; password grant; client_credentials
 *   grant since Washington DC with glide.oauth.inbound.client.credential.grant_type.enabled):
 *   https://www.servicenow.com/docs/bundle/zurich-platform-security/page/administer/security/concept/c_OAuthApplications.html
 *   and https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB1645212
 * - Inbound REST rate limits (429 + Retry-After, X-RateLimit-*):
 *   https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/inbound-REST-API-rate-limiting.html
 * - Outbound REST message (what the customer's Business Rule/Flow uses to call us):
 *   https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/outbound-rest/concept/c_OutboundRESTWebService.html
 * - sys_audit / sys_journal_field are platform tables read through the Table
 *   API; their field names (tablename, documentkey, fieldname, oldvalue,
 *   newvalue, record_checkpoint; name, element, element_id, value) come from
 *   the platform dictionary and community docs, not a dedicated API page.
 *   Reading them needs an ACL grant for the integration user (admin, or a
 *   custom read ACL): confirm on a real instance.
 *
 * AUTH — `credentialsSchema` is one object with optional fields, resolved in
 * this order:
 * 1. clientId + clientSecret → OAuth. With username + password it's the
 *    password grant, otherwise client_credentials. The access token is fetched
 *    through ctx.fetch and cached in the create() closure until shortly before
 *    `expires_in`.
 * 2. accessToken → used as a Bearer token as-is (the worker refreshes it).
 * 3. username + password → HTTP Basic.
 *
 * READ — the Table API is called with sysparm_display_value=false and
 * sysparm_exclude_reference_link=true, so every field is its raw value (choice
 * codes like state "3", reference fields as plain sys_ids) and names come from
 * dot-walked fields in sysparm_fields (caller_id.email, assigned_to.name…).
 * Raw datetimes are "YYYY-MM-DD HH:mm:ss" in UTC (display values would be in
 * the integration user's timezone, which is why we never use them).
 * CAVEAT (needs a real instance): we assume a literal datetime inside
 * sysparm_query is compared against the stored UTC value. If an instance
 * interprets it in the session timezone, set the integration user's timezone
 * to UTC.
 *
 * PAGINATION — the Table API offers offset paging (and a Link header built from
 * it), but offsets over a sort key that moves (sys_updated_on) skip rows when a
 * record is updated mid-scan. We page by keyset instead: the cursor re-anchors
 * on the last row's sys_updated_on and skips the rows already seen at exactly
 * that second (ties are ordered by sys_id).
 *
 * STATUS — the raw status combines `state` and `hold_reason`: state "3" (On
 * Hold) with a hold reason becomes "3:<hold_reason>", e.g. "3:1" (Awaiting
 * Caller) → pending, "3:4" (Awaiting Vendor) → on_hold. Other states are the
 * bare state code. Custom hold reasons surface as mapping issues.
 *
 * HISTORY — sys_audit (fieldname state, hold_reason, priority, assigned_to) plus
 * sys_journal_field (element comments = public, work_notes = internal). The
 * incident's `description` is the opening message. Author role of a journal
 * entry comes from its sys_created_by (a user_name):
 * - equals the caller's user_name → requester
 * - "system" or one of config.botUserNames (the customer's integration or
 *   automation accounts) → bot
 * - anyone else → agent
 *
 * WEBHOOKS — ServiceNow outbound REST messages are unsigned, so the customer's
 * Business Rule (after insert/update on incident) or Flow sends a shared secret
 * in the `X-Slai-Webhook-Secret` header, compared in constant time. Expected
 * body (JSON, POST):
 *   {"sys_id": "${current.sys_id}", "number": "${current.number}", "table": "incident"}
 * Only sys_id is required; number and table are informational.
 *
 * WRITE — comments / work_notes via PATCH on the incident (the journal entry's
 * sys_id isn't returned, so commentSourceId is null). Priority is normally
 * calculated from impact × urgency by the Priority Data Lookup rule, so we
 * write the impact/urgency pair that the out-of-box lookup maps to the target
 * priority (see PRIORITY_TO_IMPACT_URGENCY). Instances with custom lookup rules
 * may land on a different priority. Tags (sys_tags / label_entry) are not
 * supported.
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor } from "../lib/events.js";
import { header, safeEqual } from "../lib/hmac.js";
import { basicAuth, HttpClient, requestToken } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { plainText } from "../lib/text.js";
import { parseAs, tryJson } from "../lib/validate.js";
import {
  type CanonicalComment,
  type CanonicalEvent,
  type CanonicalTicket,
  type ConnectorClient,
  type ConnectorContext,
  type ConnectorDefinition,
  ConnectorError,
  type FieldMapping,
} from "../types.js";

const optional = z.string().trim().min(1).optional();
const credentialsSchema = z
  .object({
    instanceUrl: z.url({ protocol: /^https$/ }).transform((u) => u.replace(/\/+$/, "")),
    username: optional,
    password: z.string().min(1).optional(),
    clientId: optional,
    clientSecret: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
  })
  .superRefine((c, issue) => {
    const oauth = c.clientId !== undefined || c.clientSecret !== undefined;
    if (oauth && (c.clientId === undefined || c.clientSecret === undefined)) {
      issue.addIssue({ code: "custom", path: ["clientSecret"], message: "OAuth needs both client ID and secret" });
    }
    if ((c.username === undefined) !== (c.password === undefined)) {
      issue.addIssue({ code: "custom", path: ["password"], message: "Username and password go together" });
    }
    if (!oauth && c.accessToken === undefined && c.username === undefined) {
      issue.addIssue({
        code: "custom",
        path: ["username"],
        message: "Enter a username and password, an OAuth client ID and secret, or an access token",
      });
    }
  });
export type ServiceNowCredentials = z.infer<typeof credentialsSchema>;

const configSchema = z
  .object({
    pageSize: z.number().int().min(1).max(10_000).default(100),
    /** user_names whose journal entries count as bot (integration/automation accounts). */
    botUserNames: z.array(z.string()).default([]),
  })
  .loose();

const defaultMapping: FieldMapping = {
  status: {
    "1": "new",
    "2": "open",
    "3": "on_hold",
    "3:1": "pending", // Awaiting Caller
    "3:3": "on_hold", // Awaiting Problem
    "3:4": "on_hold", // Awaiting Vendor
    "3:5": "on_hold", // Awaiting Change
    "6": "solved",
    "7": "closed",
    "8": "closed", // Canceled
  },
  priority: { "1": "urgent", "2": "high", "3": "normal", "4": "low", "5": "low" },
};

/**
 * Out-of-box Priority Data Lookup (impact × urgency → priority), inverted to one
 * pair per priority: 1 = 1/1, 2 = 1/2, 3 = 2/2, 4 = 2/3, 5 = 3/3.
 */
export const PRIORITY_TO_IMPACT_URGENCY: Record<string, { impact: string; urgency: string }> = {
  "1": { impact: "1", urgency: "1" },
  "2": { impact: "1", urgency: "2" },
  "3": { impact: "2", urgency: "2" },
  "4": { impact: "2", urgency: "3" },
  "5": { impact: "3", urgency: "3" },
};

const HISTORY_PAGE = 1000;
/** Refresh an OAuth token this long before it expires. */
const TOKEN_SKEW_MS = 60_000;

const INCIDENT_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "hold_reason",
  "priority",
  "caller_id",
  "caller_id.user_name",
  "caller_id.name",
  "caller_id.email",
  "company",
  "company.name",
  "assigned_to",
  "assigned_to.name",
  "assignment_group",
  "contact_type",
  "sys_created_on",
  "sys_created_by",
  "sys_updated_on",
].join(",");

/** ServiceNow returns "" for empty fields; normalize to null. */
const str = z
  .string()
  .nullish()
  .transform((v) => (v === undefined || v === null || v === "" ? null : v));
const sysTime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "YYYY-MM-DD HH:mm:ss");

const zIncident = z.object({
  sys_id: z.string().min(1),
  number: str,
  short_description: str,
  description: str,
  state: z.string(),
  hold_reason: str,
  priority: str,
  caller_id: str,
  "caller_id.user_name": str,
  "caller_id.name": str,
  "caller_id.email": str,
  company: str,
  "company.name": str,
  assigned_to: str,
  "assigned_to.name": str,
  assignment_group: str,
  contact_type: str,
  sys_created_on: sysTime,
  sys_created_by: str,
  sys_updated_on: sysTime,
});
type Incident = z.infer<typeof zIncident>;

const zAudit = z.object({
  sys_id: z.string().min(1),
  fieldname: z.string(),
  oldvalue: str,
  newvalue: str,
  sys_created_on: sysTime,
  sys_created_by: str,
  record_checkpoint: z.union([z.string(), z.number()]).transform(Number).nullish(),
});
type Audit = z.infer<typeof zAudit>;

const zJournal = z.object({
  sys_id: z.string().min(1),
  element: z.string(),
  value: str,
  sys_created_on: sysTime,
  sys_created_by: str,
});

const zToken = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().nullish() });
const zWebhook = z.object({ sys_id: z.string().regex(/^[0-9a-f]{32}$/i) }).loose();

const result = <S extends z.ZodType>(s: S) => z.object({ result: s });

/** Date → ServiceNow's internal "YYYY-MM-DD HH:mm:ss" (UTC, second precision, floored). */
export function toSnTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** ServiceNow's internal "YYYY-MM-DD HH:mm:ss" (UTC) → Date. */
export function fromSnTime(v: string, what: string): Date {
  const d = new Date(`${v.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad timestamp for ${what}: ${v}`);
  return d;
}

/** state + hold_reason → the raw status the mapping sees (see header). */
export function rawStatusOf(state: string, holdReason: string | null): string {
  return state === "3" && holdReason ? `3:${holdReason}` : state;
}

export const servicenow: ConnectorDefinition<ServiceNowCredentials> = {
  provider: "servicenow",
  displayName: "ServiceNow",
  authKind: "basic",
  credentialsSchema,
  credentialFields: [
    { key: "instanceUrl", label: "Instance URL", secret: false, placeholder: "https://acme.service-now.com" },
    {
      key: "username",
      label: "Username",
      secret: false,
      help: "Integration user with itil plus read access to sys_audit and sys_journal_field.",
    },
    { key: "password", label: "Password", secret: true },
    {
      key: "clientId",
      label: "OAuth client ID (optional)",
      secret: false,
      help: "System OAuth → Application Registry. With username/password: password grant; alone: client credentials.",
    },
    { key: "clientSecret", label: "OAuth client secret (optional)", secret: true },
    { key: "accessToken", label: "OAuth access token (optional)", secret: true },
  ],
  supportsWebhooks: true,
  webhookSetup: {
    secret: "slai",
    steps: [
      "System Web Services → Outbound → REST Message: new message with endpoint {url}, POST method, header X-Slai-Webhook-Secret: {secret}.",
      'System Definition → Business Rules: new rule on Incident, after insert and update, that sends the message with a JSON body whose sys_id is current.sys_id.',
    ],
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: false },
  defaultMapping,
  docsUrl:
    "https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html",
  create(ctx: ConnectorContext<ServiceNowCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const cfg = configSchema.parse(ctx.config ?? {});
    const base = creds.instanceUrl;
    const host = new URL(base).host;
    const bots = new Set(["system", ...cfg.botUserNames].map((u) => u.toLowerCase()));
    const key = (...parts: (string | number)[]) => ["servicenow", host, ...parts].join(":");

    const client = (authorization: string) =>
      new HttpClient({
        baseUrl: base,
        fetch: ctx.fetch,
        signal: ctx.signal,
        headers: { Authorization: authorization },
      });

    let cached: { http: HttpClient; expiresAt: number } | null = null;

    /** Exchanges client credentials (or the password grant) at /oauth_token.do. */
    const fetchToken = async (): Promise<{ token: string; expiresAt: number }> => {
      const params: Record<string, string> = {
        grant_type: creds.username ? "password" : "client_credentials",
        client_id: creds.clientId ?? "",
        client_secret: creds.clientSecret ?? "",
      };
      if (creds.username && creds.password) {
        params.username = creds.username;
        params.password = creds.password;
      }
      // ServiceNow answers bad client credentials with 401 (and some grant errors with 400).
      const data = await requestToken({ fetch: ctx.fetch, signal: ctx.signal, url: `${base}/oauth_token.do`, params });
      const t = parseAs(zToken, data, "oauth token");
      return { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 1800) * 1000 };
    };

    const api = async (): Promise<HttpClient> => {
      if (creds.clientId && creds.clientSecret) {
        if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.http;
        const t = await fetchToken();
        cached = { http: client(`Bearer ${t.token}`), expiresAt: t.expiresAt };
        return cached.http;
      }
      if (!cached) {
        const auth = creds.accessToken
          ? `Bearer ${creds.accessToken}`
          : basicAuth(creds.username ?? "", creds.password ?? "");
        cached = { http: client(auth), expiresAt: Number.POSITIVE_INFINITY };
      }
      return cached.http;
    };

    const tableQuery = { sysparm_display_value: "false", sysparm_exclude_reference_link: "true" };

    const snapshot = (t: Incident): CanonicalTicket => {
      const rawStatus = rawStatusOf(t.state, t.hold_reason);
      const m = mappingIssues(ctx.mapping, rawStatus, t.priority);
      return {
        ref: {
          sourceId: t.sys_id,
          displayKey: t.number ?? t.sys_id,
          url: `${base}/incident.do?sys_id=${t.sys_id}`,
        },
        subject: t.short_description ?? "",
        status: m.status,
        rawStatus,
        priority: m.priority,
        rawPriority: t.priority,
        requester: {
          sourceId: t.caller_id,
          email: t["caller_id.email"],
          name: t["caller_id.name"],
          orgSourceId: t.company,
          orgName: t["company.name"],
        },
        assignee: t.assigned_to ? { sourceId: t.assigned_to, name: t["assigned_to.name"] } : null,
        groupSourceId: t.assignment_group,
        tags: [],
        channel: t.contact_type,
        createdAt: fromSnTime(t.sys_created_on, "incident.sys_created_on"),
        updatedAt: fromSnTime(t.sys_updated_on, "incident.sys_updated_on"),
        mappingIssues: m.issues,
      };
    };

    const getIncident = async (sourceId: string) =>
      parseAs(
        result(zIncident),
        await (await api()).get(`/api/now/table/incident/${encodeURIComponent(sourceId)}`, {
          query: { ...tableQuery, sysparm_fields: INCIDENT_FIELDS },
        }),
        "incident",
      ).result;

    /** Drains an immutable history table by offset (rows never move). */
    const history = <S extends z.ZodType>(table: string, query: string, fields: string, schema: S) =>
      collectPages<z.output<S>, number>(0, async (offset) => {
        const rows = parseAs(
          result(z.array(schema)),
          await (await api()).get(`/api/now/table/${table}`, {
            query: {
              ...tableQuery,
              sysparm_query: query,
              sysparm_fields: fields,
              sysparm_limit: HISTORY_PAGE,
              sysparm_offset: offset,
            },
          }),
          table,
        ).result;
        return { items: rows, next: rows.length >= HISTORY_PAGE ? offset + HISTORY_PAGE : null };
      });

    const roleOf = (userName: string | null, callerUserName: string | null): AuthorRole => {
      const u = (userName ?? "").toLowerCase();
      if (callerUserName && u === callerUserName.toLowerCase()) return "requester";
      if (u === "" || bots.has(u)) return "bot";
      return "agent";
    };

    return {
      async testConnection() {
        parseAs(
          result(z.array(z.object({ sys_id: z.string() }))),
          await (await api()).get("/api/now/table/incident", {
            query: { ...tableQuery, sysparm_fields: "sys_id", sysparm_limit: 1 },
          }),
          "incident",
        );
        return { accountName: host, accountId: host };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { since: string; skip: number } =>
          typeof (v as { since?: unknown })?.since === "string" && typeof (v as { skip?: unknown })?.skip === "number";
        const state = decodeCursor(cursor, isState) ?? { since: toSnTime(since), skip: 0 };
        const rows = parseAs(
          result(z.array(zIncident)),
          await (await api()).get("/api/now/table/incident", {
            query: {
              ...tableQuery,
              sysparm_query: `sys_updated_on>=${state.since}^ORDERBYsys_updated_on^ORDERBYsys_id`,
              sysparm_fields: INCIDENT_FIELDS,
              sysparm_limit: cfg.pageSize,
              sysparm_offset: state.skip,
            },
          }),
          "incidents",
        ).result;
        let nextCursor: string | null = null;
        const last = rows.at(-1);
        if (last && rows.length >= cfg.pageSize) {
          // Keyset: re-anchor on the last second seen, skipping rows already returned at it.
          const tied = rows.filter((r) => r.sys_updated_on === last.sys_updated_on).length;
          const skip = last.sys_updated_on === state.since ? state.skip + tied : tied;
          nextCursor = encodeCursor({ since: last.sys_updated_on, skip });
        }
        return { items: rows.map(snapshot), nextCursor };
      },

      async getTicketWithHistory(sourceId) {
        const inc = await getIncident(sourceId);
        const id = inc.sys_id;
        const audits = await history(
          "sys_audit",
          `tablename=incident^documentkey=${id}^fieldnameINstate,hold_reason,priority,assigned_to^ORDERBYsys_created_on`,
          "sys_id,fieldname,oldvalue,newvalue,sys_created_on,sys_created_by,record_checkpoint",
          zAudit,
        );
        const journal = await history(
          "sys_journal_field",
          `name=incident^element_id=${id}^elementINcomments,work_notes^ORDERBYsys_created_on`,
          "sys_id,element,value,sys_created_on,sys_created_by",
          zJournal,
        );

        const sorted = [...audits].sort(
          (a, b) =>
            a.sys_created_on.localeCompare(b.sys_created_on) || (a.record_checkpoint ?? 0) - (b.record_checkpoint ?? 0),
        );
        // Initial value of a field: the first audit's old value, except that an
        // insert audit (empty old value at the creation second) carries it as
        // the new value. Never audited → the current value.
        const initial = (field: string, current: string | null) => {
          const first = sorted.find((a) => a.fieldname === field);
          if (!first) return current;
          if (first.oldvalue === null && first.sys_created_on === inc.sys_created_on) return first.newvalue;
          return first.oldvalue;
        };
        let st = initial("state", inc.state) ?? inc.state;
        let hold = initial("hold_reason", inc.hold_reason);
        const createdAt = fromSnTime(inc.sys_created_on, "incident.sys_created_on");
        const events: CanonicalEvent[] = [
          {
            type: "created",
            at: createdAt,
            status: mapStatus(ctx.mapping, rawStatusOf(st, hold)).value,
            priority: mapPriority(ctx.mapping, initial("priority", inc.priority)).value,
            idempotencyKey: key("incident", id, "created"),
          },
        ];

        // One transaction writes state and hold_reason rows at the same second;
        // group them so "3" then "3:1" doesn't show up as two transitions.
        const groups = new Map<string, Audit[]>();
        for (const a of sorted) groups.set(a.sys_created_on, [...(groups.get(a.sys_created_on) ?? []), a]);
        for (const [when, rows] of groups) {
          const at = fromSnTime(when, "sys_audit.sys_created_on");
          const before = rawStatusOf(st, hold);
          let statusRow: Audit | null = null;
          for (const a of rows) {
            if (a.fieldname === "state" && a.newvalue) {
              st = a.newvalue;
              statusRow ??= a;
            } else if (a.fieldname === "hold_reason") {
              hold = a.newvalue;
              statusRow ??= a;
            } else if (a.fieldname === "priority") {
              events.push({
                type: "priority_changed",
                at,
                priority: mapPriority(ctx.mapping, a.newvalue).value,
                rawPriority: a.newvalue,
                idempotencyKey: key("audit", a.sys_id),
              });
            } else if (a.fieldname === "assigned_to") {
              events.push({
                type: "assignee_changed",
                at,
                assigneeSourceId: a.newvalue,
                idempotencyKey: key("audit", a.sys_id),
              });
            }
          }
          const after = rawStatusOf(st, hold);
          if (statusRow && after !== before) {
            events.push({
              type: "status_changed",
              at,
              status: mapStatus(ctx.mapping, after).value,
              rawStatus: after,
              idempotencyKey: key("audit", statusRow.sys_id),
            });
          }
        }

        const callerUser = inc["caller_id.user_name"];
        const comments: CanonicalComment[] = [];
        const openingRole = roleOf(inc.sys_created_by, callerUser);
        const openingId = `${id}:description`;
        events.push({
          type: "comment",
          at: createdAt,
          author: openingEventAuthor(openingRole),
          public: true,
          commentSourceId: openingId,
          idempotencyKey: key("incident", id, "description"),
        });
        comments.push({
          sourceId: openingId,
          at: createdAt,
          authorRole: openingRole,
          authorName: inc.sys_created_by,
          authorSourceId: openingRole === "requester" ? inc.caller_id : null,
          public: true,
          bodyText: plainText(inc.description ?? inc.short_description),
        });

        const entries = [...journal].sort(
          (a, b) => a.sys_created_on.localeCompare(b.sys_created_on) || a.sys_id.localeCompare(b.sys_id),
        );
        for (const j of entries) {
          const at = fromSnTime(j.sys_created_on, `journal ${j.sys_id}`);
          const role = roleOf(j.sys_created_by, callerUser);
          const pub = j.element === "comments";
          events.push({
            type: "comment",
            at,
            author: role,
            public: pub,
            commentSourceId: j.sys_id,
            idempotencyKey: key("journal", j.sys_id),
          });
          comments.push({
            sourceId: j.sys_id,
            at,
            authorRole: role,
            // sys_created_by is a user_name; we only know the sys_id for the caller.
            authorName: j.sys_created_by,
            authorSourceId: role === "requester" ? inc.caller_id : null,
            public: pub,
            bodyText: plainText(j.value),
          });
        }

        return { ticket: snapshot(inc), events: dropNoopChanges(finalizeEvents(events)), comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const token = header(req.headers, "x-slai-webhook-secret");
        if (!token || !safeEqual(token, secret)) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [parsed.data.sys_id.toLowerCase()] };
      },

      async postInternalNote(sourceId, body) {
        await (await api()).patch(
          `/api/now/table/incident/${encodeURIComponent(sourceId)}`,
          { work_notes: body },
          { query: { sysparm_fields: "sys_id" } },
        );
        return { commentSourceId: null };
      },

      async postPublicReply(sourceId, body) {
        await (await api()).patch(
          `/api/now/table/incident/${encodeURIComponent(sourceId)}`,
          { comments: body },
          { query: { sysparm_fields: "sys_id" } },
        );
        return { commentSourceId: null };
      },

      async updateTicket(sourceId, patch) {
        if (patch.addTags?.length) throw new ConnectorError("ServiceNow tags are not supported", "unsupported");
        const update: Record<string, string> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          const pair = raw === null ? undefined : PRIORITY_TO_IMPACT_URGENCY[raw];
          if (!pair) throw new ConnectorError(`no ServiceNow priority is mapped to "${patch.priority}"`, "invalid");
          update.impact = pair.impact;
          update.urgency = pair.urgency;
        }
        if (patch.assigneeSourceId !== undefined) update.assigned_to = patch.assigneeSourceId;
        if (Object.keys(update).length === 0) return;
        await (await api()).patch(`/api/now/table/incident/${encodeURIComponent(sourceId)}`, update, {
          query: { sysparm_fields: "sys_id" },
        });
      },
    };
  },
};
