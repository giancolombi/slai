/**
 * Jira Service Management (Cloud) connector.
 *
 * API docs (verified 2026-09):
 * - Jira platform REST v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 *   (OpenAPI: https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json)
 *   - POST /rest/api/3/search/jql (nextPageToken / isLast), GET /issue/{id}, /issue/{id}/changelog,
 *     /issue/{id}/comment (ADF body, jsdPublic, author.accountType), PUT /issue/{id}, PUT /issue/{id}/assignee
 * - JSM REST (request comments, public/internal): https://developer.atlassian.com/cloud/jira/service-desk/rest/
 * - Webhooks: https://developer.atlassian.com/cloud/jira/platform/webhooks/
 * - JQL date fields (unquoted number = epoch millis): https://support.atlassian.com/jira-software-cloud/docs/jql-fields/
 *
 * Auth: API token as Basic `email:token`.
 *
 * History: the issue changelog gives status/priority/assignee/label transitions;
 * platform comments carry `jsdPublic` (public reply vs internal note) and the
 * author's `accountType` (customer / atlassian / app). The issue description is
 * the reporter's opening message. We derive first response ourselves.
 *
 * Webhooks implemented:
 * - Admin-registered webhooks with a secret: `X-Hub-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`.
 * - OAuth 2.0 app dynamic webhooks: `Authorization: Bearer <JWT>` signed HS256 with the
 *   app's client secret (pass the client secret as the webhook secret). We check the
 *   signature and `exp` only; we do not verify the `qsh` claim.
 * - Connect/Forge app webhooks (asymmetric JWT) are not implemented.
 */
import type { AuthorRole, TicketStatus } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, verifyHmac, verifyHs256Jwt } from "../lib/hmac.js";
import { basicAuth, HttpClient } from "../lib/http.js";
import { mapPriority, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
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
  type MappingIssue,
} from "../types.js";
import { adfToText } from "./adf.js";

const credentialsSchema = z.object({
  siteUrl: z
    .url({ protocol: /^https$/, error: "Use your https site URL, e.g. https://acme.atlassian.net" })
    .transform((u) => u.replace(/\/+$/, "")),
  email: z.email(),
  apiToken: z.string().min(1),
});
export type JsmCredentials = z.infer<typeof credentialsSchema>;

const configSchema = z.object({
  projectKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Jira project keys are upper case")).optional(),
});

/** Keys are Jira's display names (proper case) so reverse lookups yield valid names. */
const defaultMapping: FieldMapping = {
  status: {
    "Waiting for support": "open",
    "Waiting for customer": "pending",
    Pending: "on_hold",
    "In progress": "open",
    "Work in progress": "open",
    Escalated: "open",
    Open: "open",
    "To Do": "new",
    New: "new",
    Reopened: "open",
    Resolved: "solved",
    Done: "solved",
    Closed: "closed",
    Canceled: "closed",
    Cancelled: "closed",
    Declined: "closed",
  },
  priority: {
    Highest: "urgent",
    Critical: "urgent",
    Blocker: "urgent",
    High: "high",
    Major: "high",
    Medium: "normal",
    Low: "low",
    Minor: "low",
    Lowest: "low",
    Trivial: "low",
  },
};

const CATEGORY_FALLBACK: Record<string, TicketStatus> = { new: "new", indeterminate: "open", done: "solved" };

const FIELDS = ["summary", "status", "priority", "reporter", "assignee", "labels", "created", "updated", "project"];

const zUser = z.object({
  accountId: z.string(),
  displayName: z.string().nullish(),
  emailAddress: z.string().nullish(),
  accountType: z.string().nullish(),
});
const zIssue = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }).nullish() }).nullish(),
    priority: z.object({ name: z.string() }).nullish(),
    reporter: zUser.nullish(),
    assignee: zUser.nullish(),
    labels: z.array(z.string()).nullish(),
    created: z.string(),
    updated: z.string(),
    description: z.unknown().optional(),
    project: z.object({ key: z.string() }).nullish(),
  }),
});
type JIssue = z.infer<typeof zIssue>;

const zSearch = z.object({
  issues: z.array(zIssue),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
});
const zHistory = z.object({
  id: z.string(),
  author: zUser.nullish(),
  created: z.string(),
  items: z.array(
    z.object({
      field: z.string(),
      fieldId: z.string().nullish(),
      from: z.string().nullish(),
      fromString: z.string().nullish(),
      to: z.string().nullish(),
      toString: z.string().nullish(),
    }),
  ),
});
type JHistory = z.infer<typeof zHistory>;
const zChangelog = z.object({
  values: z.array(zHistory),
  startAt: z.number(),
  total: z.number().nullish(),
  isLast: z.boolean().nullish(),
});
const zComment = z.object({
  id: z.string(),
  author: zUser.nullish(),
  body: z.unknown().optional(),
  created: z.string(),
  jsdPublic: z.boolean().nullish(),
});
type JComment = z.infer<typeof zComment>;
const zComments = z.object({
  comments: z.array(zComment),
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
});

const zWebhook = z
  .object({
    webhookEvent: z.string(),
    issue: z.object({ id: z.union([z.string(), z.number()]).transform(String), key: z.string().nullish() }).loose(),
  })
  .loose();

export const jiraServiceManagement: ConnectorDefinition<JsmCredentials> = {
  provider: "jira_service_management",
  displayName: "Jira Service Management",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    { key: "siteUrl", label: "Site URL", secret: false, placeholder: "https://acme.atlassian.net" },
    { key: "email", label: "Account email", secret: false, placeholder: "admin@acme.com" },
    {
      key: "apiToken",
      label: "API token",
      secret: true,
      help: "Create one at https://id.atlassian.com/manage-profile/security/api-tokens",
    },
  ],
  supportsWebhooks: true,
  webhookSetup: {
    secret: "slai",
    steps: [
      "Jira settings → System → WebHooks → Create a WebHook with URL {url} and secret {secret}.",
      "Events: Issue created, updated and deleted; Comment created and updated. Optionally restrict with JQL to your service project.",
    ],
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developer.atlassian.com/cloud/jira/service-desk/rest/",
  create(ctx: ConnectorContext<JsmCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const cfg = configSchema.safeParse(ctx.config ?? {});
    if (!cfg.success) throw new ConnectorError(`jsm: invalid config: ${cfg.error.message}`, "invalid");
    const projectKeys = cfg.data.projectKeys ?? [];
    const site = creds.siteUrl;
    const host = new URL(site).host;
    const http = new HttpClient({
      baseUrl: site,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: basicAuth(creds.email, creds.apiToken) },
    });
    const key = (...parts: (string | number)[]) => ["jsm", host, ...parts].join(":");

    const statusOf = (issue: JIssue): { status: TicketStatus; raw: string; issue: MappingIssue | null } => {
      const raw = issue.fields.status?.name ?? "";
      const m = mapStatus(ctx.mapping, raw);
      if (m.known) return { status: m.value, raw, issue: null };
      const cat = issue.fields.status?.statusCategory?.key;
      return {
        status: (cat && CATEGORY_FALLBACK[cat]) || m.value,
        raw,
        issue: { field: "status", raw },
      };
    };

    const snapshot = (issue: JIssue): CanonicalTicket => {
      const f = issue.fields;
      const s = statusOf(issue);
      const rawPriority = f.priority?.name ?? null;
      const p = mapPriority(ctx.mapping, rawPriority);
      const issues: MappingIssue[] = [];
      if (s.issue) issues.push(s.issue);
      if (!p.known && rawPriority) issues.push({ field: "priority", raw: rawPriority });
      return {
        ref: { sourceId: issue.id, displayKey: issue.key, url: `${site}/browse/${issue.key}` },
        subject: f.summary ?? "",
        status: s.status,
        rawStatus: s.raw,
        priority: p.value,
        rawPriority,
        requester: {
          sourceId: f.reporter?.accountId ?? null,
          email: f.reporter?.emailAddress ?? null,
          name: f.reporter?.displayName ?? null,
          orgSourceId: null,
          orgName: null,
        },
        assignee: f.assignee ? { sourceId: f.assignee.accountId, name: f.assignee.displayName ?? null } : null,
        groupSourceId: null,
        tags: f.labels ?? [],
        channel: null,
        createdAt: parseTime(f.created, "issue.created"),
        updatedAt: parseTime(f.updated, "issue.updated"),
        mappingIssues: issues,
      };
    };

    const roleOf = (author: z.infer<typeof zUser> | null | undefined, reporterId: string | null): AuthorRole => {
      if (!author) return "system";
      if (author.accountType === "app") return "bot";
      if (author.accountType === "customer") return "requester";
      if (reporterId && author.accountId === reporterId) return "requester";
      return "agent";
    };

    const buildHistory = (issue: JIssue, histories: JHistory[], raw: JComment[]) => {
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];
      const reporterId = issue.fields.reporter?.accountId ?? null;
      const sorted = [...histories].sort(
        (a, b) => Date.parse(a.created) - Date.parse(b.created) || Number(a.id) - Number(b.id),
      );
      const allItems = sorted.flatMap((h) => h.items);
      const firstStatus = allItems.find((i) => i.field === "status");
      const firstPriority = allItems.find((i) => i.field === "priority");
      const created = parseTime(issue.fields.created, "issue.created");
      const initialStatus = firstStatus ? (firstStatus.fromString ?? "") : statusOf(issue).raw;
      const initialPriority = firstPriority
        ? (firstPriority.fromString ?? null)
        : (issue.fields.priority?.name ?? null);
      events.push({
        type: "created",
        at: created,
        status: firstStatus ? mapStatus(ctx.mapping, initialStatus).value : statusOf(issue).status,
        priority: mapPriority(ctx.mapping, initialPriority).value,
        idempotencyKey: key("issue", issue.id, "created"),
      });

      // The description is the reporter's opening message.
      const description = adfToText(issue.fields.description);
      if (description) {
        const role = roleOf(issue.fields.reporter, reporterId);
        const sourceId = `${issue.id}:description`;
        events.push({
          type: "comment",
          at: created,
          author: openingEventAuthor(role),
          public: true,
          commentSourceId: sourceId,
          idempotencyKey: key("issue", issue.id, "description"),
        });
        comments.push({
          sourceId,
          at: created,
          authorRole: role,
          authorName: issue.fields.reporter?.displayName ?? null,
          authorSourceId: reporterId,
          public: true,
          bodyText: description,
        });
      }

      for (const h of sorted) {
        const at = parseTime(h.created, `changelog ${h.id}`);
        h.items.forEach((it, idx) => {
          const k = key("changelog", h.id, idx);
          if (it.field === "status" && it.toString) {
            events.push({
              type: "status_changed",
              at,
              status: mapStatus(ctx.mapping, it.toString).value,
              rawStatus: it.toString,
              idempotencyKey: k,
            });
          } else if (it.field === "priority") {
            const raw = it.toString || null;
            events.push({
              type: "priority_changed",
              at,
              priority: mapPriority(ctx.mapping, raw).value,
              rawPriority: raw,
              idempotencyKey: k,
            });
          } else if (it.field === "assignee") {
            events.push({ type: "assignee_changed", at, assigneeSourceId: it.to || null, idempotencyKey: k });
          } else if (it.field === "labels") {
            const tags = (it.toString ?? "").split(/\s+/).filter(Boolean);
            events.push({ type: "tags_changed", at, tags, idempotencyKey: k });
          }
        });
      }

      for (const c of raw) {
        const at = parseTime(c.created, `comment ${c.id}`);
        const role = roleOf(c.author, reporterId);
        const pub = c.jsdPublic !== false;
        events.push({
          type: "comment",
          at,
          author: role,
          public: pub,
          commentSourceId: c.id,
          idempotencyKey: key("comment", c.id),
        });
        comments.push({
          sourceId: c.id,
          at,
          authorRole: role,
          authorName: c.author?.displayName ?? null,
          authorSourceId: c.author?.accountId ?? null,
          public: pub,
          bodyText: adfToText(c.body),
        });
      }
      comments.sort((a, b) => a.at.getTime() - b.at.getTime());
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    return {
      async testConnection() {
        parseAs(zUser, await http.get("/rest/api/3/myself"), "myself");
        return { accountName: host, accountId: host };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { t: string } => typeof (v as { t?: unknown })?.t === "string";
        const state = decodeCursor(cursor, isState);
        const scope = projectKeys.length > 0 ? `project in (${projectKeys.join(",")}) AND ` : "";
        const body: Record<string, unknown> = {
          jql: `${scope}updated >= ${since.getTime()} ORDER BY updated ASC`,
          fields: FIELDS,
          maxResults: 100,
        };
        if (state) body.nextPageToken = state.t;
        const data = parseAs(zSearch, await http.post("/rest/api/3/search/jql", body), "search/jql");
        return {
          items: data.issues.map(snapshot),
          nextCursor: data.isLast === false && data.nextPageToken ? encodeCursor({ t: data.nextPageToken }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const iid = encodeURIComponent(sourceId);
        const issue = parseAs(
          zIssue,
          await http.get(`/rest/api/3/issue/${iid}`, { query: { fields: [...FIELDS, "description"].join(",") } }),
          "issue",
        );
        const histories = await collectPages<JHistory, number>(0, async (startAt) => {
          const page = parseAs(
            zChangelog,
            await http.get(`/rest/api/3/issue/${iid}/changelog`, { query: { startAt, maxResults: 100 } }),
            "changelog",
          );
          const next = startAt + page.values.length;
          const done =
            page.isLast === true ||
            page.values.length === 0 ||
            (page.isLast == null && page.total != null && next >= page.total);
          return { items: page.values, next: done ? null : next };
        });
        const rawComments = await collectPages<JComment, number>(0, async (startAt) => {
          const page = parseAs(
            zComments,
            await http.get(`/rest/api/3/issue/${iid}/comment`, {
              query: { startAt, maxResults: 100, orderBy: "created" },
            }),
            "comments",
          );
          const next = startAt + page.comments.length;
          return { items: page.comments, next: page.comments.length === 0 || next >= page.total ? null : next };
        });
        const { events, comments } = buildHistory(issue, histories, rawComments);
        return { ticket: snapshot(issue), events, comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const hub = header(req.headers, "x-hub-signature");
        const auth = header(req.headers, "authorization");
        let verified = false;
        if (hub) {
          verified = verifyHmac({
            algo: "sha256",
            secret,
            payload: req.rawBody,
            signature: hub,
            encoding: "hex",
            prefix: "sha256=",
          });
        } else if (auth?.toLowerCase().startsWith("bearer ")) {
          verified = verifyHs256Jwt(auth.slice(7).trim(), secret, Date.now()) !== null;
        }
        if (!verified) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [parsed.data.issue.id] };
      },

      async postInternalNote(sourceId, body) {
        return comment(sourceId, body, false);
      },

      async postPublicReply(sourceId, body) {
        return comment(sourceId, body, true);
      },

      async updateTicket(sourceId, patch) {
        const iid = encodeURIComponent(sourceId);
        const fields: Record<string, unknown> = {};
        const update: Record<string, unknown> = {};
        if (patch.priority) {
          const name = rawPriorityFor(ctx.mapping, patch.priority) ?? rawPriorityFor(defaultMapping, patch.priority);
          if (!name) throw new ConnectorError(`jsm: no Jira priority maps to ${patch.priority}`, "invalid");
          fields.priority = { name };
        }
        if (patch.addTags?.length) update.labels = patch.addTags.map((add) => ({ add }));
        if (Object.keys(fields).length > 0 || Object.keys(update).length > 0) {
          const body: Record<string, unknown> = {};
          if (Object.keys(fields).length > 0) body.fields = fields;
          if (Object.keys(update).length > 0) body.update = update;
          await http.put(`/rest/api/3/issue/${iid}`, body);
        }
        if (patch.assigneeSourceId !== undefined) {
          await http.put(`/rest/api/3/issue/${iid}/assignee`, { accountId: patch.assigneeSourceId });
        }
      },
    };

    async function comment(sourceId: string, body: string, pub: boolean) {
      const r = parseAs(
        z.object({ id: z.union([z.string(), z.number()]).transform(String) }).loose(),
        await http.post(`/rest/servicedeskapi/request/${encodeURIComponent(sourceId)}/comment`, {
          body,
          public: pub,
        }),
        "request comment",
      );
      return { commentSourceId: r.id };
    }
  },
};
