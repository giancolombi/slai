/**
 * Front connector (conversations as tickets).
 *
 * API docs (verified 2026-09, Core API at https://api2.frontapp.com):
 * - Auth (API token, Bearer) and token identity (GET /me): https://dev.frontapp.com/reference/api-token-details
 * - Conversation object, status / status_category enums: https://dev.frontapp.com/reference/get-conversation-by-id
 * - Company events (GET /events, q[after], sort_by=created_at): https://dev.frontapp.com/reference/list-events
 * - Event types, sources and targets: https://dev.frontapp.com/reference/events
 * - Conversation events: https://dev.frontapp.com/reference/list-conversation-events
 * - Conversation messages: https://dev.frontapp.com/reference/list-conversation-messages
 * - Conversation comments: https://dev.frontapp.com/reference/list-conversation-comments
 * - Teammate `type` enum (user, rule, ai, api, …): https://dev.frontapp.com/reference/get-teammate
 * - Add comment: https://dev.frontapp.com/reference/add-comment
 * - Reply (202 + message_uid, options.archive defaults to true): https://dev.frontapp.com/reference/create-message-reply
 * - Assignee: https://dev.frontapp.com/reference/update-conversation-assignee
 * - Conversation tags (by tag_ids only): https://dev.frontapp.com/reference/add-conversation-tag
 * - Tags list/create: https://dev.frontapp.com/reference/list-tags
 * - Search syntax (after: covers messages/comments only): https://dev.frontapp.com/docs/search-1
 * - Application webhooks (HMAC-SHA256 of `timestamp:body`, base64): https://dev.frontapp.com/docs/application-webhooks
 * - Rule webhooks (HMAC-SHA1 of body with the API secret, base64): https://dev.frontapp.com/docs/rule-webhooks
 * - Rate limits (429 + Retry-After): https://dev.frontapp.com/docs/rate-limiting
 * - Message templates (saved replies; `_results[]` id/name/subject/body HTML, `limit` ≤ 100,
 *   `_pagination.next`): https://dev.frontapp.com/reference/list-message-templates
 *   Company templates only: team and teammate templates have their own endpoints and are not read.
 * - Template variables (`{{recipient.first_name}}`): https://help.front.com/en/articles/2306
 *
 * Updated-since listing uses the company event feed (GET /events?q[after]=…,
 * oldest first) rather than conversation search: search's `after:` filter only
 * matches message/comment creation, so archive, assign, tag and ticket-status
 * changes would be missed. Every event embeds its conversation, which becomes
 * the snapshot. The feed pages at most 15 events, so one page may carry fewer
 * conversations than events (we dedupe within a page; the worker dedupes
 * across pages).
 *
 * History: state changes come from conversation events (assign/unassign,
 * archive/reopen, trash/restore, reminder, tag/untag, ticket_status_update);
 * comments come from the messages (public) and comments (internal) endpoints.
 *
 * Status. Front has no single status; we derive a raw status:
 *   deleted (trashed) > ticket status category (open/waiting/resolved, when
 *   ticketing is on) > snoozed > archived > assigned/unassigned.
 * Default mapping: archived → solved (archiving is Front's "done": the
 * conversation reopens on the next inbound message, like a Zendesk solve, so
 * it is not terminal), deleted → closed, snoozed/waiting → pending.
 * Snoozes are not their own event type: a snooze archives the conversation
 * and a `reminder` event reopens it. We therefore read an archive whose next
 * state event is a `reminder` (or, for the latest archive, a conversation that
 * is archived with scheduled reminders) as "snoozed". This is an inference,
 * not a documented field; confirm against a real account.
 * With ticketing on, custom ticket statuses collapse to their category.
 *
 * Priority. Front has no native priority: it is read from tags. A tag is a
 * priority tag when the mapping knows it (e.g. "urgent", "priority: high") or
 * its name starts with "priority" (unknown ones are flagged in mappingIssues).
 * With several, the most urgent mapped tag wins. Priority writes swap tags.
 *
 * Idempotency keys omit the account: Front ids (evt_, msg_, com_) are
 * globally unique, and API tokens carry no company id without a GET /me.
 */
import type { AuthorRole, Priority } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, hmac, safeEqual } from "../lib/hmac.js";
import { forbiddenAsUnsupported, HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText, plainText, savedReplyText, textToHtml } from "../lib/text.js";
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

const BASE = "https://api2.frontapp.com";
/** Application webhooks carry a ms timestamp; Front recommends a 5 minute window. */
const WEBHOOK_MAX_AGE_MS = 5 * 60_000;

const credentialsSchema = z.object({
  apiToken: z.string().min(1),
  /** Optional teammate (tea_…) that notes and replies are sent as (`author_id`). */
  teammateId: z.string().trim().min(1).optional(),
});
export type FrontCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: {
    unassigned: "open",
    assigned: "open",
    snoozed: "pending",
    archived: "solved",
    deleted: "closed",
    // Ticket status categories (ticketing enabled).
    open: "open",
    waiting: "pending",
    resolved: "solved",
  },
  // Tag names. rawPriorityFor picks the first key per priority for writes.
  priority: {
    "priority: urgent": "urgent",
    "priority: high": "high",
    "priority: normal": "normal",
    "priority: low": "low",
    urgent: "urgent",
  },
};

const PRIORITY_RANK: Record<Priority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

/** Teammate types acting for automation (rules, AI, integrations, CSAT). */
const BOT_TYPES = new Set(["rule", "ai", "api", "application", "integration", "csat", "smart_csat"]);

const zTeammate = z.object({
  id: z.string(),
  email: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  username: z.string().nullish(),
  type: z.string().nullish(),
});
type ZTeammate = z.infer<typeof zTeammate>;
const zTag = z.object({ id: z.string(), name: z.string() });
const zRecipient = z.object({
  handle: z.string().nullish(),
  role: z.string().nullish(),
  name: z.string().nullish(),
  _links: z
    .object({ related: z.object({ contact: z.string().nullish() }).loose().nullish() })
    .loose()
    .nullish(),
});
const zConversation = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  status: z.string(),
  status_id: z.string().nullish(),
  status_category: z.string().nullish(),
  ticket_ids: z.array(z.string()).nullish(),
  assignee: zTeammate.nullish(),
  recipient: zRecipient.nullish(),
  tags: z.array(zTag).nullish(),
  scheduled_reminders: z.array(z.unknown()).nullish(),
  created_at: z.number(),
  updated_at: z.number().nullish(),
});
type ZConversation = z.infer<typeof zConversation>;
const zRef = z
  .object({ _meta: z.object({ type: z.string() }).loose().nullish(), data: z.unknown() })
  .loose()
  .nullish();
const zEvent = z.object({
  id: z.string(),
  type: z.string(),
  emitted_at: z.number(),
  source: zRef,
  target: zRef,
  conversation: zConversation.nullish(),
});
type ZEvent = z.infer<typeof zEvent>;
const zMessage = z.object({
  id: z.string(),
  type: z.string().nullish(),
  is_inbound: z.boolean(),
  draft_mode: z.string().nullish(),
  created_at: z.number(),
  author: zTeammate.nullish(),
  recipients: z.array(zRecipient).nullish(),
  body: z.string().nullish(),
  text: z.string().nullish(),
});
type ZMessage = z.infer<typeof zMessage>;
const zComment = z.object({
  id: z.string(),
  author: zTeammate.nullish(),
  body: z.string().nullish(),
  posted_at: z.number(),
});
type ZComment = z.infer<typeof zComment>;
const list = <T extends z.ZodType>(item: T) =>
  z.object({ _pagination: z.object({ next: z.string().nullish() }).nullish(), _results: z.array(item) });

const zTemplate = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    body: z.string().nullish(),
    updated_at: z.number().nullish(),
  })
  .loose();

const zTargetTeammate = z.object({ id: z.string() }).loose();
const zTargetStatus = z.object({ id: z.string().nullish(), name: z.string().nullish(), category: z.string() }).loose();

const cnvId = z.string().regex(/^cnv_[a-z0-9]+$/i);
const zWebhook = z.union([
  // Application webhook: {type, authorization: {id}, payload: <event with conversation>}
  z.object({ payload: z.object({ conversation: z.object({ id: cnvId }).loose() }).loose() }).loose(),
  // Rule webhook: the event itself (full or preview)
  z.object({ conversation: z.object({ id: cnvId }).loose() }).loose(),
  // A rule/custom body with our documented shape: {"conversation_id": "cnv_…"}
  z.object({ conversation_id: cnvId }).loose(),
  // Application webhook with no conversation (e.g. the "sync" validation ping).
  z.object({ type: z.string(), authorization: z.object({ id: z.string() }).loose() }).loose(),
]);

/** Front timestamps are Unix seconds with a fractional part. */
function unix(v: number | null | undefined, what: string): Date {
  return parseTime(v === null || v === undefined ? v : Math.round(v * 1000), what);
}

function teammateName(t: ZTeammate | null | undefined): string | null {
  if (!t) return null;
  const n = [t.first_name, t.last_name].filter(Boolean).join(" ");
  return n || t.username || t.email || null;
}

function roleOf(author: ZTeammate | null | undefined): AuthorRole {
  // Outbound with no teammate: auto-replies and rule/API sends. Counting those as
  // bot never hides a missed first response (unverified: needs a real account).
  if (!author) return "bot";
  return author.type && BOT_TYPES.has(author.type) ? "bot" : "agent";
}

/** Only follow pagination links on Front's own API hosts (they may be company-specific). */
function frontUrl(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new ConnectorError("Front: malformed pagination link", "upstream");
  }
  if (url.protocol !== "https:" || !(url.hostname === "frontapp.com" || url.hostname.endsWith(".frontapp.com"))) {
    throw new ConnectorError("Front: pagination link to an unexpected host", "upstream");
  }
  return url.toString();
}

export const front: ConnectorDefinition<FrontCredentials> = {
  provider: "front",
  displayName: "Front",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    {
      key: "apiToken",
      label: "API token",
      secret: true,
      help: "Settings → Developers → API tokens (scopes: shared resources read/write)",
    },
    {
      key: "teammateId",
      label: "Teammate ID for write-back (optional)",
      secret: false,
      placeholder: "tea_abc12",
      help: "Notes and replies are sent as this teammate",
    },
  ],
  supportsWebhooks: true,
  supportsSavedReplies: true,
  webhookSetup: {
    secret: "provider",
    steps: [
      "Settings → Developers → your app → Webhooks: set the URL to {url} and enable the conversation events.",
      "Paste the app's signing secret below (for a rule webhook, use the company's API secret).",
    ],
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://dev.frontapp.com/reference/introduction",
  create(ctx: ConnectorContext<FrontCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const http = new HttpClient({
      baseUrl: BASE,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: `Bearer ${creds.apiToken}` },
    });
    const key = (...parts: (string | number)[]) => ["front", ...parts].join(":");

    const isPriorityTag = (name: string) => mapPriority(ctx.mapping, name).known || /^priority\b/i.test(name.trim());

    /** The raw priority a tag set implies: the most urgent mapped tag, else the first unmapped one. */
    const priorityFromTags = (tags: string[]): string | null => {
      let best: { raw: string; rank: number } | null = null;
      let unmapped: string | null = null;
      for (const t of tags) {
        if (!isPriorityTag(t)) continue;
        const m = mapPriority(ctx.mapping, t);
        if (!m.known) {
          unmapped ??= t;
          continue;
        }
        const rank = m.value ? PRIORITY_RANK[m.value] : 0;
        if (!best || rank > best.rank) best = { raw: t, rank };
      }
      return best?.raw ?? unmapped;
    };

    const rawStatusOf = (c: ZConversation): string => {
      if (c.status === "deleted") return "deleted";
      if (c.status_category) return c.status_category;
      if (c.status === "archived" && (c.scheduled_reminders?.length ?? 0) > 0) return "snoozed";
      return c.status;
    };

    const snapshot = (c: ZConversation): CanonicalTicket => {
      const tags = (c.tags ?? []).map((t) => t.name);
      const rawStatus = rawStatusOf(c);
      const rawPriority = priorityFromTags(tags);
      const m = mappingIssues(ctx.mapping, rawStatus, rawPriority);
      const r = c.recipient;
      const contact = r?._links?.related?.contact?.match(/\/contacts\/([^/?#]+)/)?.[1] ?? null;
      return {
        ref: {
          sourceId: c.id,
          displayKey: c.ticket_ids?.[0] ?? c.id,
          // Front's documented deep link (app.frontapp.com/open/<id>).
          url: `https://app.frontapp.com/open/${c.id}`,
        },
        subject: c.subject ?? "",
        status: m.status,
        rawStatus,
        priority: m.priority,
        rawPriority,
        requester: {
          sourceId: contact,
          email: r?.handle?.includes("@") ? r.handle : null,
          name: r?.name ?? null,
          // Contact accounts need a separate call per contact; not fetched.
          orgSourceId: null,
          orgName: null,
        },
        assignee: c.assignee ? { sourceId: c.assignee.id, name: teammateName(c.assignee) } : null,
        // Inboxes are only linked (_links.related.inboxes), not embedded.
        groupSourceId: null,
        tags,
        channel: null,
        createdAt: unix(c.created_at, "conversation.created_at"),
        updatedAt: unix(c.updated_at ?? c.created_at, "conversation.updated_at"),
        mappingIssues: m.issues,
      };
    };

    const drain = <T extends z.ZodType>(first: string, item: T, what: string) =>
      collectPages<z.output<T>, string>(first, async (url) => {
        const page = parseAs(list(item), await http.get(url), what);
        return { items: page._results, next: page._pagination?.next ? frontUrl(page._pagination.next) : null };
      });

    const buildHistory = (c: ZConversation, rawEvents: ZEvent[], messages: ZMessage[], notes: ZComment[]) => {
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];

      // Comments first: public messages and internal comments.
      type Item = { at: Date; comment: CanonicalComment; kind: "message" | "comment" };
      const items: Item[] = [];
      for (const msg of messages) {
        if (msg.draft_mode) continue;
        const at = unix(msg.created_at, `message ${msg.id}`);
        const from = msg.recipients?.find((r) => r.role === "from");
        const role: AuthorRole = msg.is_inbound ? "requester" : roleOf(msg.author);
        items.push({
          at,
          kind: "message",
          comment: {
            sourceId: msg.id,
            at,
            authorRole: role,
            authorName: msg.is_inbound ? (from?.name ?? from?.handle ?? null) : teammateName(msg.author),
            authorSourceId: msg.is_inbound ? (from?.handle ?? null) : (msg.author?.id ?? null),
            public: true,
            bodyText: msg.text ? plainText(msg.text) : htmlToText(msg.body),
          },
        });
      }
      for (const n of notes) {
        const at = unix(n.posted_at, `comment ${n.id}`);
        items.push({
          at,
          kind: "comment",
          comment: {
            sourceId: n.id,
            at,
            authorRole: n.author?.type && BOT_TYPES.has(n.author.type) ? "bot" : "agent",
            authorName: teammateName(n.author),
            authorSourceId: n.author?.id ?? null,
            public: false,
            bodyText: plainText(n.body),
          },
        });
      }
      items.sort((a, b) => a.at.getTime() - b.at.getTime());
      items.forEach((it, i) => {
        comments.push(it.comment);
        events.push({
          type: "comment",
          at: it.at,
          author: i === 0 ? openingEventAuthor(it.comment.authorRole) : it.comment.authorRole,
          public: it.comment.public,
          commentSourceId: it.comment.sourceId,
          idempotencyKey: key(it.kind, it.comment.sourceId),
        });
      });

      // State replay over conversation events, oldest first (the API lists newest first).
      const chrono = [...rawEvents]
        .reverse()
        .map((e, i) => ({ e, i }))
        .sort((a, b) => a.e.emitted_at - b.e.emitted_at || a.i - b.i)
        .map(({ e }) => e);
      const STATE_TYPES = new Set(["archive", "reopen", "reminder", "trash", "restore"]);
      let archived = false;
      let snoozed = false;
      let deleted = false;
      let assigned = false;
      let category: string | null = null;
      const tags: string[] = [];
      const raw = () =>
        deleted
          ? "deleted"
          : category
            ? category
            : archived
              ? snoozed
                ? "snoozed"
                : "archived"
              : assigned
                ? "assigned"
                : "unassigned";
      let rawStatus = raw();
      let rawPriority: string | null = null;

      const createdAt = unix(c.created_at, "conversation.created_at");
      events.push({
        type: "created",
        at: createdAt,
        status: mapStatus(ctx.mapping, rawStatus).value,
        priority: null,
        idempotencyKey: key("conversation", c.id, "created"),
      });

      chrono.forEach((e, idx) => {
        const at = unix(e.emitted_at, `event ${e.id}`);
        const k = key("event", e.id);
        switch (e.type) {
          case "assign": {
            const t = zTargetTeammate.safeParse(e.target?.data);
            assigned = t.success;
            events.push({
              type: "assignee_changed",
              at,
              assigneeSourceId: t.success ? t.data.id : null,
              idempotencyKey: k,
            });
            break;
          }
          case "unassign":
            assigned = false;
            events.push({ type: "assignee_changed", at, assigneeSourceId: null, idempotencyKey: k });
            break;
          case "archive": {
            archived = true;
            const next = chrono.slice(idx + 1).find((x) => STATE_TYPES.has(x.type));
            snoozed = next
              ? next.type === "reminder"
              : c.status === "archived" && (c.scheduled_reminders?.length ?? 0) > 0;
            break;
          }
          case "reopen":
          case "reminder":
            archived = false;
            snoozed = false;
            break;
          case "trash":
            deleted = true;
            break;
          case "restore":
            deleted = false;
            break;
          case "ticket_status_update": {
            const s = zTargetStatus.safeParse(e.target?.data);
            if (s.success) category = s.data.category;
            break;
          }
          case "tag":
          case "untag": {
            const t = zTag.safeParse(e.target?.data);
            if (!t.success) break;
            const i = tags.findIndex((x) => x.toLowerCase() === t.data.name.toLowerCase());
            if (e.type === "tag" && i === -1) tags.push(t.data.name);
            else if (e.type === "untag" && i !== -1) tags.splice(i, 1);
            else break;
            events.push({ type: "tags_changed", at, tags: [...tags], idempotencyKey: k });
            const p = priorityFromTags(tags);
            if (p !== rawPriority) {
              rawPriority = p;
              events.push({
                type: "priority_changed",
                at,
                priority: mapPriority(ctx.mapping, p).value,
                rawPriority: p,
                idempotencyKey: key("event", e.id, "priority"),
              });
            }
            break;
          }
          default:
            break;
        }
        const r = raw();
        if (r !== rawStatus) {
          rawStatus = r;
          events.push({
            type: "status_changed",
            at,
            status: mapStatus(ctx.mapping, r).value,
            rawStatus: r,
            idempotencyKey: key("event", e.id, "status"),
          });
        }
      });

      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    /** Tag names → ids, creating tags that don't exist yet (Front tags conversations by id only). */
    const tagIds = async (names: string[]): Promise<string[]> => {
      const all = await drain("/tags?limit=100", zTag, "tags");
      const out: string[] = [];
      for (const name of names) {
        const hit = all.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (hit) {
          out.push(hit.id);
          continue;
        }
        const created = parseAs(zTag, await http.post("/tags", { name }), "create tag");
        out.push(created.id);
      }
      return out;
    };

    return {
      async testConnection() {
        const me = parseAs(z.object({ id: z.string(), name: z.string() }), await http.get("/me"), "me");
        return { accountName: me.name, accountId: me.id };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { n: string } => typeof (v as { n?: unknown })?.n === "string";
        const state = decodeCursor(cursor, isState);
        const data = parseAs(
          list(zEvent),
          await http.get(
            state ? frontUrl(state.n) : "/events",
            state
              ? {}
              : {
                  query: {
                    "q[after]": since.getTime() / 1000,
                    sort_by: "created_at",
                    sort_order: "asc",
                    limit: 15,
                  },
                },
          ),
          "events",
        );
        const latest = new Map<string, ZConversation>();
        for (const e of data._results) {
          if (!e.conversation) continue;
          // Later events carry the same or newer state; keep the last one seen.
          latest.delete(e.conversation.id);
          latest.set(e.conversation.id, e.conversation);
        }
        const next = data._pagination?.next ? frontUrl(data._pagination.next) : null;
        return {
          items: [...latest.values()].map(snapshot),
          nextCursor: next && data._results.length > 0 ? encodeCursor({ n: next }) : null,
        };
      },

      async listSavedReplies(cursor) {
        return forbiddenAsUnsupported("Front message templates", async () => {
          const isState = (v: unknown): v is { n: string } => typeof (v as { n?: unknown })?.n === "string";
          const state = decodeCursor(cursor, isState);
          const data = parseAs(
            list(zTemplate),
            await http.get(state ? frontUrl(state.n) : "/message_templates", state ? {} : { query: { limit: 100 } }),
            "message templates",
          );
          const items: KnowledgeArticle[] = [];
          for (const t of data._results) {
            const bodyText = savedReplyText(t.body, "html");
            if (!bodyText) continue;
            items.push({
              sourceId: t.id,
              title: t.name ?? "",
              url: null,
              bodyText,
              locale: null,
              // Front does not document a template timestamp; a fixed one keeps syncs deterministic.
              updatedAt: t.updated_at ? unix(t.updated_at, `message template ${t.id}`) : new Date(0),
            });
          }
          const next = data._pagination?.next ? frontUrl(data._pagination.next) : null;
          return { items, nextCursor: next && data._results.length > 0 ? encodeCursor({ n: next }) : null };
        });
      },

      async getTicketWithHistory(sourceId) {
        const cid = encodeURIComponent(sourceId);
        const conv = parseAs(zConversation, await http.get(`/conversations/${cid}`), "conversation");
        const events = await drain(`/conversations/${cid}/events?limit=100`, zEvent, "conversation events");
        const messages = await drain(
          `/conversations/${cid}/messages?limit=100&sort_by=created_at&sort_order=asc`,
          zMessage,
          "messages",
        );
        const notes = await drain(`/conversations/${cid}/comments`, zComment, "comments");
        const h = buildHistory(conv, events, messages, notes);
        return { ticket: snapshot(conv), ...h };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const sig = header(req.headers, "x-front-signature");
        if (!sig) return { ok: false, reason: "bad_signature" };
        const ts = header(req.headers, "x-front-request-timestamp");
        let expected: string;
        if (ts !== undefined) {
          // Application webhooks: HMAC-SHA256 over `${timestamp}:${body}`, base64; ts in ms.
          if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > WEBHOOK_MAX_AGE_MS) {
            return { ok: false, reason: "bad_signature" };
          }
          expected = hmac("sha256", secret, `${ts}:${req.rawBody}`, "base64");
        } else {
          // Rule webhooks: HMAC-SHA1 over the body with the API secret, base64 (no timestamp).
          expected = hmac("sha1", secret, req.rawBody, "base64");
        }
        if (!safeEqual(sig.trim(), expected)) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const p = parsed.data as {
          payload?: { conversation?: { id: string } };
          conversation?: { id: string };
          conversation_id?: string;
        };
        const id = p.payload?.conversation?.id ?? p.conversation?.id ?? p.conversation_id;
        return { ok: true, ticketSourceIds: id ? [id] : [] };
      },

      async postInternalNote(sourceId, body) {
        const r = parseAs(
          zComment.pick({ id: true }).loose(),
          await http.post(`/conversations/${encodeURIComponent(sourceId)}/comments`, {
            body,
            ...(creds.teammateId ? { author_id: creds.teammateId } : {}),
          }),
          "comment",
        );
        return { commentSourceId: r.id };
      },

      async postPublicReply(sourceId, body) {
        // 202 {status: "accepted", message_uid}; the uid is not the message id, so we
        // return null and let the next history fetch pick the message up.
        await http.post(`/conversations/${encodeURIComponent(sourceId)}/messages`, {
          body: textToHtml(body),
          ...(creds.teammateId ? { author_id: creds.teammateId } : {}),
          // Front archives on reply by default, which would stop the SLA clock.
          options: { archive: false },
        });
        return { commentSourceId: null };
      },

      async updateTicket(sourceId, patch) {
        const cid = encodeURIComponent(sourceId);
        const add = [...(patch.addTags ?? [])];
        const remove: string[] = [];
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (!raw) throw new ConnectorError(`Front: no priority tag is mapped to ${patch.priority}`, "invalid");
          const conv = parseAs(zConversation, await http.get(`/conversations/${cid}`), "conversation");
          for (const t of conv.tags ?? []) {
            if (isPriorityTag(t.name) && t.name.toLowerCase() !== raw.toLowerCase()) remove.push(t.id);
          }
          add.push(raw);
        }
        if (patch.assigneeSourceId !== undefined) {
          await http.put(`/conversations/${cid}/assignee`, { assignee_id: patch.assigneeSourceId });
        }
        if (remove.length > 0)
          await http.request("DELETE", `/conversations/${cid}/tags`, { body: { tag_ids: remove } });
        if (add.length > 0) await http.post(`/conversations/${cid}/tags`, { tag_ids: await tagIds(add) });
      },
    };
  },
};
