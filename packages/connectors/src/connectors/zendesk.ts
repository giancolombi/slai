/**
 * Zendesk Support connector.
 *
 * API docs (verified 2026-09):
 * - Auth (API token, Basic `{email}/token:{token}`): https://developer.zendesk.com/api-reference/introduction/security-and-auth/
 * - Incremental cursor export: https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/
 * - Ticket audits: https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/
 * - Audit events: https://developer.zendesk.com/documentation/ticketing/reference-guides/ticket-audit-events-reference/
 * - Tickets (update, comment): https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
 * - Tags without overwrite: https://developer.zendesk.com/documentation/ticketing/managing-tickets/adding-tags-to-tickets-without-overwriting-existing-tags/
 * - Webhook signatures: https://developer.zendesk.com/documentation/webhooks/verifying/
 * - Help Center articles (cursor pagination, draft flag, html_url): https://developer.zendesk.com/api-reference/help_center/help-center-api/articles/
 * - Webhook event payloads: https://developer.zendesk.com/api-reference/webhooks/event-types/ticket-events/
 *
 * History comes from ticket audits: every field change and comment with its
 * timestamp and author. The first public agent reply is derived from comments
 * (we don't trust Zendesk's reply-time metric as the source of truth).
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, verifyHmac } from "../lib/hmac.js";
import { basicAuth, HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { oauthFetch, oauthTokenFields, readTokens } from "../lib/oauth.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText, plainText } from "../lib/text.js";
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
  type KnowledgeArticle,
} from "../types.js";

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/;
const credentialsSchema = z
  .object({
    subdomain: z.string().trim().toLowerCase().regex(SUBDOMAIN, "Just the subdomain, e.g. acme for acme.zendesk.com"),
    /** API token auth (email + token), or an OAuth access token from the connect flow. */
    email: z.email().optional(),
    apiToken: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    ...oauthTokenFields,
  })
  .refine((c) => c.accessToken !== undefined || (c.email !== undefined && c.apiToken !== undefined), {
    message: "Agent email and API token are required.",
    path: ["apiToken"],
  });
export type ZendeskCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: { new: "new", open: "open", pending: "pending", hold: "on_hold", solved: "solved", closed: "closed" },
  priority: { urgent: "urgent", high: "high", normal: "normal", low: "low" },
};

const id = z.union([z.number(), z.string()]).transform(String);
const zUser = z.object({
  id,
  name: z.string().nullish(),
  email: z.string().nullish(),
  role: z.string().nullish(),
  organization_id: id.nullish(),
});
const zOrg = z.object({ id, name: z.string().nullish() });
const zTicket = z.object({
  id,
  subject: z.string().nullish(),
  status: z.string(),
  priority: z.string().nullish(),
  requester_id: id.nullish(),
  assignee_id: id.nullish(),
  group_id: id.nullish(),
  organization_id: id.nullish(),
  tags: z.array(z.string()).nullish(),
  via: z.object({ channel: z.string().nullish() }).nullish(),
  created_at: z.string(),
  updated_at: z.string(),
});
type ZTicket = z.infer<typeof zTicket>;
type ZUser = z.infer<typeof zUser>;

const zVia = z.object({ channel: z.union([z.string(), z.number()]).nullish() }).nullish();
const zAuditEvent = z.object({
  id,
  type: z.string(),
  field_name: z.string().nullish(),
  value: z.unknown().optional(),
  previous_value: z.unknown().optional(),
  body: z.string().nullish(),
  html_body: z.string().nullish(),
  plain_body: z.string().nullish(),
  public: z.boolean().nullish(),
  author_id: id.nullish(),
  via: zVia,
});
const zAudit = z.object({
  id,
  created_at: z.string(),
  author_id: id.nullish(),
  via: zVia,
  events: z.array(zAuditEvent),
});
type ZAudit = z.infer<typeof zAudit>;

const zIncremental = z.object({
  tickets: z.array(zTicket),
  users: z.array(zUser).nullish(),
  organizations: z.array(zOrg).nullish(),
  after_cursor: z.string().nullish(),
  end_of_stream: z.boolean(),
});
const zShow = z.object({ ticket: zTicket, users: z.array(zUser).nullish(), organizations: z.array(zOrg).nullish() });
const zAudits = z.object({
  audits: z.array(zAudit),
  users: z.array(zUser).nullish(),
  meta: z.object({ has_more: z.boolean() }).nullish(),
  links: z.object({ next: z.string().nullish() }).nullish(),
});
const zArticle = z.object({
  id,
  title: z.string().nullish(),
  html_url: z.string().nullish(),
  body: z.string().nullish(),
  locale: z.string().nullish(),
  draft: z.boolean().nullish(),
  updated_at: z.string(),
});
const zArticles = z.object({
  articles: z.array(zArticle),
  meta: z.object({ has_more: z.boolean().nullish(), after_cursor: z.string().nullish() }).nullish(),
});

const zUpdate = z.object({
  ticket: zTicket.partial().nullish(),
  audit: z.object({ events: z.array(z.object({ id, type: z.string() })) }).nullish(),
});

/** Zendesk's system user; comments authored by it come from automations. */
const SYSTEM_USER_ID = "-1";
const BOT_CHANNELS = new Set(["rule", "automation", "answer_bot", "answer_bot_for_agents", "sample_ticket"]);

const zWebhook = z.union([
  // Event-subscribed webhooks: {type: "zen:event-type:ticket.*", detail: {id}, subject: "zen:ticket:123"}
  z.object({ type: z.string(), detail: z.object({ id }).loose() }).loose(),
  z.object({ subject: z.string().regex(/^zen:ticket:\d+$/) }).loose(),
  // Trigger/automation webhooks with our documented body: {"ticket_id": "{{ticket.id}}"}
  z.object({ ticket_id: id }).loose(),
  z.object({ ticket: z.object({ id }).loose() }).loose(),
]);

function roleFor(userId: string | null | undefined, via: z.infer<typeof zVia>, users: Map<string, ZUser>): AuthorRole {
  if (userId === SYSTEM_USER_ID) return "bot";
  if (via?.channel !== undefined && via?.channel !== null && BOT_CHANNELS.has(String(via.channel))) return "bot";
  const u = userId ? users.get(userId) : undefined;
  if (!u?.role) return "agent";
  return u.role === "end-user" ? "requester" : "agent";
}

export const zendesk: ConnectorDefinition<ZendeskCredentials> = {
  provider: "zendesk",
  displayName: "Zendesk",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    { key: "subdomain", label: "Subdomain", secret: false, placeholder: "acme", help: "acme for acme.zendesk.com" },
    { key: "email", label: "Agent email", secret: false, placeholder: "admin@acme.com" },
    {
      key: "apiToken",
      label: "API token",
      secret: true,
      help: "Admin Center → Apps and integrations → Zendesk API → API tokens",
    },
  ],
  supportsWebhooks: true,
  webhookSetup: {
    secret: "provider",
    steps: [
      "Admin Center → Apps and integrations → Webhooks → Create webhook → Trigger or automation.",
      "Endpoint URL {url}, method POST, format JSON, no authentication. Create it.",
      "Open the webhook, choose Reveal secret, and paste the signing secret below.",
      'Objects and rules → Triggers: add a trigger on "Ticket is Created or Updated" that notifies this webhook with the body {"ticket_id": "{{ticket.id}}"}.',
    ],
  },
  oauth: {
    authorizeUrl: "https://{subdomain}.zendesk.com/oauth/authorizations/new",
    tokenUrl: "https://{subdomain}.zendesk.com/oauth/tokens",
    scopes: ["read", "write"],
    pkce: true,
    params: [
      {
        key: "subdomain",
        label: "Zendesk subdomain",
        placeholder: "acme",
        help: "acme for acme.zendesk.com",
        pattern: "[a-z0-9][a-z0-9-]*",
      },
    ],
    toCredentials: ({ token, clientId, clientSecret, params, now }) => ({
      subdomain: params.subdomain,
      ...readTokens(token, now),
      clientId,
      clientSecret,
    }),
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developer.zendesk.com/api-reference/",
  supportsKnowledge: true,
  create(ctx: ConnectorContext<ZendeskCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const sub = creds.subdomain;
    const http = new HttpClient({
      baseUrl: `https://${sub}.zendesk.com`,
      fetch: creds.accessToken ? oauthFetch(ctx, creds, `https://${sub}.zendesk.com/oauth/tokens`) : ctx.fetch,
      signal: ctx.signal,
      headers: creds.accessToken
        ? {}
        : { Authorization: basicAuth(`${creds.email ?? ""}/token`, creds.apiToken ?? "") },
    });
    const key = (...parts: (string | number)[]) => ["zendesk", sub, ...parts].join(":");

    const snapshot = (t: ZTicket, users: Map<string, ZUser>, orgs: Map<string, string | null>): CanonicalTicket => {
      const m = mappingIssues(ctx.mapping, t.status, t.priority ?? null);
      const requester = t.requester_id ? users.get(t.requester_id) : undefined;
      const assignee = t.assignee_id ? users.get(t.assignee_id) : undefined;
      const orgId = t.organization_id ?? requester?.organization_id ?? null;
      return {
        ref: { sourceId: t.id, displayKey: `#${t.id}`, url: `https://${sub}.zendesk.com/agent/tickets/${t.id}` },
        subject: t.subject ?? "",
        status: m.status,
        rawStatus: t.status,
        priority: m.priority,
        rawPriority: t.priority ?? null,
        requester: {
          sourceId: t.requester_id ?? null,
          email: requester?.email ?? null,
          name: requester?.name ?? null,
          orgSourceId: orgId,
          orgName: orgId ? (orgs.get(orgId) ?? null) : null,
        },
        assignee: t.assignee_id ? { sourceId: t.assignee_id, name: assignee?.name ?? null } : null,
        groupSourceId: t.group_id ?? null,
        tags: t.tags ?? [],
        channel: t.via?.channel ?? null,
        createdAt: parseTime(t.created_at, "ticket.created_at"),
        updatedAt: parseTime(t.updated_at, "ticket.updated_at"),
        mappingIssues: m.issues,
      };
    };

    const userMap = (...lists: (ZUser[] | null | undefined)[]) => {
      const m = new Map<string, ZUser>();
      for (const l of lists) for (const u of l ?? []) m.set(u.id, u);
      return m;
    };

    const buildHistory = (t: ZTicket, audits: ZAudit[], users: Map<string, ZUser>) => {
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];
      const sorted = [...audits].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id),
      );
      let createdSeen = false;
      let openingCommentSeen = false;
      for (const audit of sorted) {
        const at = parseTime(audit.created_at, `audit ${audit.id}`);
        const creates = audit.events.filter((e) => e.type === "Create");
        if (!createdSeen && creates.length > 0) {
          createdSeen = true;
          const rawStatus = String(creates.find((e) => e.field_name === "status")?.value ?? "new");
          const rawPriority = creates.find((e) => e.field_name === "priority")?.value;
          events.push({
            type: "created",
            at,
            status: mapStatus(ctx.mapping, rawStatus).value,
            priority: mapPriority(ctx.mapping, typeof rawPriority === "string" ? rawPriority : null).value,
            idempotencyKey: key("audit", audit.id, "created"),
          });
          const tags = creates.find((e) => e.field_name === "tags")?.value;
          if (Array.isArray(tags) && tags.length > 0) {
            events.push({
              type: "tags_changed",
              at,
              tags: tags.map(String),
              idempotencyKey: key("audit", audit.id, "tags"),
            });
          }
        }
        for (const e of audit.events) {
          const k = key("audit", audit.id, e.id);
          if (e.type === "Change") {
            const v = e.value;
            if (e.field_name === "status" && typeof v === "string") {
              events.push({
                type: "status_changed",
                at,
                status: mapStatus(ctx.mapping, v).value,
                rawStatus: v,
                idempotencyKey: k,
              });
            } else if (e.field_name === "priority") {
              const raw = typeof v === "string" && v !== "" ? v : null;
              events.push({
                type: "priority_changed",
                at,
                priority: mapPriority(ctx.mapping, raw).value,
                rawPriority: raw,
                idempotencyKey: k,
              });
            } else if (e.field_name === "assignee_id") {
              events.push({
                type: "assignee_changed",
                at,
                assigneeSourceId: v === null || v === undefined || v === "" ? null : String(v),
                idempotencyKey: k,
              });
            } else if (e.field_name === "tags" && Array.isArray(v)) {
              events.push({ type: "tags_changed", at, tags: v.map(String), idempotencyKey: k });
            }
          } else if (e.type === "Comment" || e.type === "VoiceComment") {
            const authorId = e.author_id ?? audit.author_id ?? null;
            const role = roleFor(authorId, e.via ?? audit.via, users);
            const pub = e.public !== false;
            const opening = !openingCommentSeen;
            openingCommentSeen = true;
            events.push({
              type: "comment",
              at,
              author: opening ? openingEventAuthor(role) : role,
              public: pub,
              commentSourceId: e.id,
              idempotencyKey: k,
            });
            comments.push({
              sourceId: e.id,
              at,
              authorRole: role,
              authorName: authorId ? (users.get(authorId)?.name ?? null) : null,
              authorSourceId: authorId,
              public: pub,
              bodyText: e.plain_body
                ? plainText(e.plain_body)
                : e.html_body
                  ? htmlToText(e.html_body)
                  : plainText(e.body),
            });
          }
        }
      }
      if (!createdSeen) {
        // Audits can be trimmed for very old/archived tickets; fall back to the snapshot.
        events.unshift({
          type: "created",
          at: parseTime(t.created_at, "ticket.created_at"),
          status: "new",
          priority: mapPriority(ctx.mapping, t.priority ?? null).value,
          idempotencyKey: key("ticket", t.id, "created"),
        });
      }
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    return {
      async testConnection() {
        const r = parseAs(
          z.object({ user: zUser.extend({ id: id.nullish() }) }),
          await http.get("/api/v2/users/me.json"),
          "users/me",
        );
        // Bad credentials can yield the anonymous user (id null) with a 200.
        if (!r.user.id || r.user.role === "end-user")
          throw new ConnectorError("Zendesk: not authenticated as an agent", "auth");
        return { accountName: `${sub}.zendesk.com`, accountId: sub };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { c: string } => typeof (v as { c?: unknown })?.c === "string";
        const state = decodeCursor(cursor, isState);
        // Zendesk rejects a start_time less than a minute in the past.
        const startTime = Math.min(Math.floor(since.getTime() / 1000), Math.floor(Date.now() / 1000) - 61);
        const data = parseAs(
          zIncremental,
          await http.get("/api/v2/incremental/tickets/cursor.json", {
            query: state
              ? { cursor: state.c, include: "users,organizations", per_page: 500 }
              : { start_time: startTime, include: "users,organizations", per_page: 500 },
          }),
          "incremental tickets",
        );
        const users = userMap(data.users);
        const orgs = new Map((data.organizations ?? []).map((o) => [o.id, o.name ?? null]));
        const items = data.tickets
          .filter((t) => t.status !== "deleted")
          .filter((t) => Date.parse(t.updated_at) >= since.getTime())
          .map((t) => snapshot(t, users, orgs));
        return {
          items,
          nextCursor: data.end_of_stream || !data.after_cursor ? null : encodeCursor({ c: data.after_cursor }),
        };
      },

      async getTicketWithHistory(sourceId) {
        const tid = encodeURIComponent(sourceId);
        const show = parseAs(
          zShow,
          await http.get(`/api/v2/tickets/${tid}.json`, { query: { include: "users,organizations" } }),
          "ticket",
        );
        const auditUsers: ZUser[] = [];
        const audits = await collectPages<ZAudit, string>(
          `/api/v2/tickets/${tid}/audits.json?page[size]=100&include=users`,
          async (url) => {
            const page = parseAs(zAudits, await http.get(url), "audits");
            auditUsers.push(...(page.users ?? []));
            const next = page.meta?.has_more && page.links?.next ? page.links.next : null;
            return { items: page.audits, next };
          },
        );
        const users = userMap(show.users, auditUsers);
        const orgs = new Map((show.organizations ?? []).map((o) => [o.id, o.name ?? null]));
        const { events, comments } = buildHistory(show.ticket, audits, users);
        return { ticket: snapshot(show.ticket, users, orgs), events, comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const ts = header(req.headers, "x-zendesk-webhook-signature-timestamp");
        const sig = header(req.headers, "x-zendesk-webhook-signature");
        if (!ts) return { ok: false, reason: "bad_signature" };
        // Signed string is TIMESTAMP + BODY, HMAC-SHA256, base64.
        if (!verifyHmac({ algo: "sha256", secret, payload: ts + req.rawBody, signature: sig, encoding: "base64" })) {
          return { ok: false, reason: "bad_signature" };
        }
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const p = parsed.data as Record<string, unknown>;
        let ticketId: string | undefined;
        if (
          typeof p.type === "string" &&
          p.type.startsWith("zen:event-type:") &&
          !p.type.startsWith("zen:event-type:ticket.")
        ) {
          return { ok: true, ticketSourceIds: [] };
        }
        if (p.detail && typeof p.detail === "object") ticketId = String((p.detail as { id: unknown }).id);
        else if (typeof p.subject === "string") ticketId = p.subject.slice("zen:ticket:".length);
        else if (p.ticket_id !== undefined) ticketId = String(p.ticket_id);
        else if (p.ticket && typeof p.ticket === "object") ticketId = String((p.ticket as { id: unknown }).id);
        if (!ticketId || !/^\d+$/.test(ticketId)) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [ticketId] };
      },

      async listKnowledgeArticles(cursor) {
        const isState = (v: unknown): v is { a: string } => typeof (v as { a?: unknown })?.a === "string";
        const state = decodeCursor(cursor, isState);
        const data = parseAs(
          zArticles,
          await http.get("/api/v2/help_center/articles.json", {
            query: { "page[size]": 100, "page[after]": state?.a },
          }),
          "help center articles",
        );
        const items: KnowledgeArticle[] = data.articles
          .filter((a) => a.draft !== true)
          .map((a) => ({
            sourceId: a.id,
            title: a.title ?? "",
            url: a.html_url ?? null,
            bodyText: htmlToText(a.body),
            locale: a.locale ?? null,
            updatedAt: parseTime(a.updated_at, `article ${a.id}.updated_at`),
          }));
        const after = data.meta?.has_more ? data.meta.after_cursor : null;
        return { items, nextCursor: after ? encodeCursor({ a: after }) : null };
      },

      async postInternalNote(sourceId, body) {
        return comment(sourceId, body, false);
      },

      async postPublicReply(sourceId, body) {
        return comment(sourceId, body, true);
      },

      async updateTicket(sourceId, patch) {
        const tid = encodeURIComponent(sourceId);
        const ticket: Record<string, unknown> = {};
        if (patch.priority) ticket.priority = rawPriorityFor(ctx.mapping, patch.priority) ?? patch.priority;
        if (patch.assigneeSourceId !== undefined) ticket.assignee_id = Number(patch.assigneeSourceId);
        if (Object.keys(ticket).length > 0) await http.put(`/api/v2/tickets/${tid}.json`, { ticket });
        // PUT /tickets/{id}/tags adds without overwriting existing tags.
        if (patch.addTags?.length) await http.put(`/api/v2/tickets/${tid}/tags.json`, { tags: patch.addTags });
      },
    };

    async function comment(sourceId: string, body: string, pub: boolean) {
      const r = parseAs(
        zUpdate,
        await http.put(`/api/v2/tickets/${encodeURIComponent(sourceId)}.json`, {
          ticket: { comment: { body, public: pub } },
        }),
        "ticket update",
      );
      const c = r.audit?.events.find((e) => e.type === "Comment");
      return { commentSourceId: c?.id ?? null };
    }
  },
};
