/**
 * Freshdesk connector.
 *
 * API docs (verified 2026-09):
 * - API v2 reference (auth, tickets, conversations, notes, reply, rate limits): https://developers.freshdesk.com/api/
 * - List tickets (updated_since, include=requester,stats, 300-page cap, Link header): https://developers.freshdesk.com/api/#list_all_tickets
 * - Conversations: https://developers.freshdesk.com/api/#list_all_ticket_notes
 * - Rate limits: https://support.freshdesk.com/support/solutions/articles/225439-what-are-the-rate-limits-for-the-api-calls-to-freshdesk-
 *
 * LIMITATION — status history is synthesized. Freshdesk API v2 has no official
 * per-ticket activities endpoint, so we rebuild status transitions from the
 * ticket's `stats` timestamps (resolved_at, closed_at, reopened_at,
 * pending_since, status_updated_at) plus the current status. Consequences:
 * - Only the latest pending/on-hold period is known; earlier ones are lost,
 *   so paused time before the latest pause is counted as running (conservative).
 * - A resolve→reopen→resolve cycle keeps only the latest resolve.
 * - Priority history is unavailable: the created event carries the current priority.
 * The first public agent reply is still derived by us from conversations.
 * Bots can't be told apart from agents (conversations have no actor type).
 *
 * WEBHOOKS — Freshdesk automation-rule webhooks are unsigned. We require a
 * shared secret token, sent either as the `X-Slai-Webhook-Token` header or the
 * `token` query parameter of the webhook URL, compared in constant time. The
 * customer configures an automation rule ("Trigger webhook", POST, JSON) with
 * body: {"freshdesk_webhook": {"ticket_id": "{{ticket.id}}"}}.
 */
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, optTime, parseTime } from "../lib/events.js";
import { header, safeEqual } from "../lib/hmac.js";
import { basicAuth, HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor, nextLink } from "../lib/paginate.js";
import { htmlToText, plainText, textToHtml } from "../lib/text.js";
import { parseAs, tryJson } from "../lib/validate.js";
import type {
  CanonicalComment,
  CanonicalEvent,
  CanonicalTicket,
  ConnectorClient,
  ConnectorContext,
  ConnectorDefinition,
  FieldMapping,
} from "../types.js";

const credentialsSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Just the subdomain, e.g. acme for acme.freshdesk.com"),
  apiKey: z.string().min(1),
});
export type FreshdeskCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: { "2": "open", "3": "pending", "4": "solved", "5": "closed", "6": "pending", "7": "on_hold" },
  priority: { "1": "low", "2": "normal", "3": "high", "4": "urgent" },
};

/** Freshdesk caps list pagination at 300 pages. */
export const FRESHDESK_MAX_PAGE = 300;

const id = z.union([z.number(), z.string()]).transform(String);
const code = z.union([z.number(), z.string()]).transform(String);
const zStats = z
  .object({
    first_responded_at: z.string().nullish(),
    agent_responded_at: z.string().nullish(),
    requester_responded_at: z.string().nullish(),
    pending_since: z.string().nullish(),
    resolved_at: z.string().nullish(),
    closed_at: z.string().nullish(),
    reopened_at: z.string().nullish(),
    status_updated_at: z.string().nullish(),
  })
  .nullish();
const zTicket = z.object({
  id,
  subject: z.string().nullish(),
  status: code,
  priority: code.nullish(),
  source: z.number().nullish(),
  requester_id: id.nullish(),
  responder_id: id.nullish(),
  group_id: id.nullish(),
  company_id: id.nullish(),
  tags: z.array(z.string()).nullish(),
  description_text: z.string().nullish(),
  description: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  requester: z.object({ id: id.nullish(), name: z.string().nullish(), email: z.string().nullish() }).nullish(),
  company: z.object({ id: id.nullish(), name: z.string().nullish() }).nullish(),
  stats: zStats,
});
type FTicket = z.infer<typeof zTicket>;
const zConversation = z.object({
  id,
  body: z.string().nullish(),
  body_text: z.string().nullish(),
  incoming: z.boolean().nullish(),
  private: z.boolean().nullish(),
  user_id: id.nullish(),
  source: z.number().nullish(),
  created_at: z.string(),
});
type FConversation = z.infer<typeof zConversation>;

const zWebhook = z.union([
  z.object({ freshdesk_webhook: z.object({ ticket_id: id }).loose() }).loose(),
  z.object({ ticket_id: id }).loose(),
]);

/** Freshdesk source codes → channel names. */
const SOURCES: Record<number, string> = {
  1: "email",
  2: "web",
  3: "phone",
  7: "chat",
  9: "feedback_widget",
  10: "outbound_email",
};

export const freshdesk: ConnectorDefinition<FreshdeskCredentials> = {
  provider: "freshdesk",
  displayName: "Freshdesk",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    { key: "domain", label: "Domain", secret: false, placeholder: "acme", help: "acme for acme.freshdesk.com" },
    { key: "apiKey", label: "API key", secret: true, help: "Profile settings → View API key" },
  ],
  supportsWebhooks: true,
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developers.freshdesk.com/api/",
  create(ctx: ConnectorContext<FreshdeskCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const domain = creds.domain;
    const http = new HttpClient({
      baseUrl: `https://${domain}.freshdesk.com`,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: basicAuth(creds.apiKey, "X") },
    });
    const key = (...parts: (string | number)[]) => ["freshdesk", domain, ...parts].join(":");

    const snapshot = (t: FTicket): CanonicalTicket => {
      const m = mappingIssues(ctx.mapping, t.status, t.priority ?? null);
      return {
        ref: { sourceId: t.id, displayKey: `#${t.id}`, url: `https://${domain}.freshdesk.com/a/tickets/${t.id}` },
        subject: t.subject ?? "",
        status: m.status,
        rawStatus: t.status,
        priority: m.priority,
        rawPriority: t.priority ?? null,
        requester: {
          sourceId: t.requester_id ?? t.requester?.id ?? null,
          email: t.requester?.email ?? null,
          name: t.requester?.name ?? null,
          orgSourceId: t.company_id ?? null,
          orgName: t.company?.name ?? null,
        },
        assignee: t.responder_id ? { sourceId: t.responder_id, name: null } : null,
        groupSourceId: t.group_id ?? null,
        tags: t.tags ?? [],
        channel: t.source !== null && t.source !== undefined ? (SOURCES[t.source] ?? String(t.source)) : null,
        createdAt: parseTime(t.created_at, "ticket.created_at"),
        updatedAt: parseTime(t.updated_at, "ticket.updated_at"),
        mappingIssues: m.issues,
      };
    };

    /** Status transitions synthesized from stats (see header: lossy by design). */
    const statusEvents = (t: FTicket): CanonicalEvent[] => {
      const s = t.stats ?? {};
      const out: { at: Date; raw: string; field: string }[] = [];
      const resolved = optTime(s.resolved_at);
      const closed = optTime(s.closed_at);
      const reopened = optTime(s.reopened_at);
      if (resolved) out.push({ at: resolved, raw: "4", field: "resolved_at" });
      if (closed) out.push({ at: closed, raw: "5", field: "closed_at" });
      if (reopened && resolved && reopened > resolved) out.push({ at: reopened, raw: "2", field: "reopened_at" });
      const current = mapStatus(ctx.mapping, t.status).value;
      const pending = optTime(s.pending_since);
      if (pending && (current === "pending" || current === "on_hold")) {
        out.push({ at: pending, raw: t.status, field: "pending_since" });
      }
      const updated = optTime(s.status_updated_at);
      if (updated && !out.some((e) => e.raw === t.status && e.at.getTime() === updated.getTime())) {
        out.push({ at: updated, raw: t.status, field: "status_updated_at" });
      }
      return out.map((e) => ({
        type: "status_changed",
        at: e.at,
        status: mapStatus(ctx.mapping, e.raw).value,
        rawStatus: e.raw,
        idempotencyKey: key("ticket", t.id, "stats", e.field, e.at.toISOString()),
      }));
    };

    const buildHistory = (t: FTicket, conversations: FConversation[]) => {
      const createdAt = parseTime(t.created_at, "ticket.created_at");
      const events: CanonicalEvent[] = [
        {
          type: "created",
          at: createdAt,
          status: mapStatus(ctx.mapping, "2").value,
          priority: mapPriority(ctx.mapping, t.priority ?? null).value,
          idempotencyKey: key("ticket", t.id, "created"),
        },
      ];
      if (t.tags?.length) {
        events.push({ type: "tags_changed", at: createdAt, tags: t.tags, idempotencyKey: key("ticket", t.id, "tags") });
      }
      const comments: CanonicalComment[] = [];
      const descId = `${t.id}:description`;
      events.push({
        type: "comment",
        at: createdAt,
        author: openingEventAuthor("requester"),
        public: true,
        commentSourceId: descId,
        idempotencyKey: key("ticket", t.id, "description"),
      });
      comments.push({
        sourceId: descId,
        at: createdAt,
        authorRole: "requester",
        authorName: t.requester?.name ?? null,
        authorSourceId: t.requester_id ?? null,
        public: true,
        bodyText: t.description_text ? plainText(t.description_text) : htmlToText(t.description),
      });
      const sorted = [...conversations].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id),
      );
      for (const c of sorted) {
        const at = parseTime(c.created_at, `conversation ${c.id}`);
        const role = c.incoming ? "requester" : "agent";
        const pub = c.private !== true;
        events.push({
          type: "comment",
          at,
          author: role,
          public: pub,
          commentSourceId: c.id,
          idempotencyKey: key("conversation", c.id),
        });
        comments.push({
          sourceId: c.id,
          at,
          authorRole: role,
          authorName: null,
          authorSourceId: c.user_id ?? null,
          public: pub,
          bodyText: c.body_text ? plainText(c.body_text) : htmlToText(c.body),
        });
      }
      events.push(...statusEvents(t));
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    return {
      async testConnection() {
        parseAs(z.object({ id }), await http.get("/api/v2/agents/me"), "agents/me");
        return { accountName: `${domain}.freshdesk.com`, accountId: domain };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { since: string; page: number } =>
          typeof (v as { since?: unknown })?.since === "string" && typeof (v as { page?: unknown })?.page === "number";
        const state = decodeCursor(cursor, isState) ?? { since: since.toISOString(), page: 1 };
        const res = await http.request<unknown>("GET", "/api/v2/tickets", {
          query: {
            updated_since: state.since,
            order_by: "updated_at",
            order_type: "asc",
            per_page: 100,
            page: state.page,
            include: "requester,stats",
          },
        });
        const tickets = parseAs(z.array(zTicket), res.data, "tickets");
        const items = tickets.map(snapshot);
        // Only presence of rel="next" matters here (we track the page number
        // ourselves); the next URL itself may contain raw commas (include=a,b).
        const hasNext = /;\s*rel="?next"?/i.test(res.headers.get("link") ?? "");
        let nextCursor: string | null = null;
        if (hasNext) {
          const last = tickets.at(-1);
          nextCursor =
            state.page >= FRESHDESK_MAX_PAGE && last
              ? encodeCursor({ since: new Date(last.updated_at).toISOString(), page: 1 })
              : encodeCursor({ since: state.since, page: state.page + 1 });
        }
        return { items, nextCursor };
      },

      async getTicketWithHistory(sourceId) {
        const tid = encodeURIComponent(sourceId);
        const ticket = parseAs(
          zTicket,
          await http.get(`/api/v2/tickets/${tid}`, { query: { include: "requester,stats,company" } }),
          "ticket",
        );
        const conversations = await collectPages<FConversation, string>(
          `/api/v2/tickets/${tid}/conversations?per_page=100&page=1`,
          async (url) => {
            const res = await http.request<unknown>("GET", url);
            return {
              items: parseAs(z.array(zConversation), res.data, "conversations"),
              next: nextLink(res.headers.get("link")),
            };
          },
        );
        const { events, comments } = buildHistory(ticket, conversations);
        return { ticket: snapshot(ticket), events, comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        let token = header(req.headers, "x-slai-webhook-token");
        if (!token) {
          try {
            token = new URL(req.url).searchParams.get("token") ?? undefined;
          } catch {
            token = undefined;
          }
        }
        if (!token || !safeEqual(token, secret)) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const p = parsed.data as { freshdesk_webhook?: { ticket_id: string }; ticket_id?: string };
        const ticketId = p.freshdesk_webhook?.ticket_id ?? p.ticket_id;
        if (!ticketId || !/^\d+$/.test(ticketId)) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [ticketId] };
      },

      async postInternalNote(sourceId, body) {
        const r = parseAs(
          z.object({ id }),
          await http.post(`/api/v2/tickets/${encodeURIComponent(sourceId)}/notes`, {
            body: textToHtml(body),
            private: true,
          }),
          "note",
        );
        return { commentSourceId: r.id };
      },

      async postPublicReply(sourceId, body) {
        const r = parseAs(
          z.object({ id }),
          await http.post(`/api/v2/tickets/${encodeURIComponent(sourceId)}/reply`, { body: textToHtml(body) }),
          "reply",
        );
        return { commentSourceId: r.id };
      },

      async updateTicket(sourceId, patch) {
        const tid = encodeURIComponent(sourceId);
        const update: Record<string, unknown> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (raw !== null) update.priority = Number(raw);
        }
        if (patch.assigneeSourceId !== undefined) update.responder_id = Number(patch.assigneeSourceId);
        if (patch.addTags?.length) {
          // PUT replaces tags, so merge with the current set.
          const current = parseAs(zTicket, await http.get(`/api/v2/tickets/${tid}`), "ticket");
          update.tags = [...new Set([...(current.tags ?? []), ...patch.addTags])];
        }
        if (Object.keys(update).length > 0) await http.put(`/api/v2/tickets/${tid}`, update);
      },
    };
  },
};
