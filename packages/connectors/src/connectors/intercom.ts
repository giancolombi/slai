/**
 * Intercom connector (conversations, including those carrying a ticket).
 *
 * API docs (verified 2026-09, API version 2.16):
 * - Conversations (retrieve, reply, manage, tags): https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations
 * - Search conversations: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/searchconversations
 * - Webhook models and signature (X-Hub-Signature, HMAC-SHA1): https://developers.intercom.com/docs/references/webhooks/webhook-models
 * - API versions / changelog: https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/api-changelog
 * - Priority writes (Preview only): https://developers.intercom.com/docs/references/preview/rest-api/api.intercom.io/conversations/updateconversation
 * - Articles (list, page/per_page, state, url): https://developers.intercom.com/docs/references/rest-api/api.intercom.io/articles/listarticles
 *
 * History comes from conversation parts. Known limits:
 * - Intercom returns at most 500 parts per conversation; older parts are lost.
 * - There is no priority history in 2.16: the created event carries the
 *   current priority.
 * - Ticket state changes are not parts; a ticket's current state is used for
 *   the snapshot, and conversation open/close/snooze parts drive the timeline.
 * - An "assign and reply" produces an `assignment` part with a body; any part
 *   with a body from an admin counts as a public reply, except `note`.
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor } from "../lib/events.js";
import { header, verifyHmac } from "../lib/hmac.js";
import { HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText } from "../lib/text.js";
import { parseAs, tryJson } from "../lib/validate.js";
import type {
  CanonicalComment,
  CanonicalEvent,
  CanonicalTicket,
  ConnectorClient,
  ConnectorContext,
  ConnectorDefinition,
  FieldMapping,
  KnowledgeArticle,
} from "../types.js";

export const INTERCOM_VERSION = "2.16";

const credentialsSchema = z.object({
  accessToken: z.string().min(1),
  /** Optional admin to attribute writes to; defaults to the token's admin (GET /me). */
  adminId: z.string().optional(),
});
export type IntercomCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: {
    open: "open",
    closed: "solved",
    snoozed: "pending",
    submitted: "new",
    in_progress: "open",
    waiting_on_customer: "pending",
    resolved: "solved",
  },
  priority: {
    urgent: "urgent",
    high: "high",
    medium: "normal",
    low: "low",
    none: null,
    priority: "high",
    not_priority: null,
  },
};

const id = z.union([z.number(), z.string()]).transform(String);
const zAuthor = z
  .object({
    type: z.string().nullish(),
    id: id.nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
  })
  .nullish();
const zPart = z.object({
  id,
  part_type: z.string(),
  body: z.string().nullish(),
  created_at: z.number(),
  assigned_to: z.object({ type: z.string().nullish(), id: id.nullish() }).nullish(),
  author: zAuthor,
});
const zTicketRef = z
  .object({
    state: z.string().nullish(),
    ticket_state: z.union([z.string(), z.object({ category: z.string().nullish() }).loose()]).nullish(),
  })
  .loose()
  .nullish();
const zConversation = z.object({
  id,
  title: z.string().nullish(),
  created_at: z.number(),
  updated_at: z.number(),
  state: z.string(),
  priority: z.string().nullish(),
  admin_assignee_id: id.nullish(),
  team_assignee_id: id.nullish(),
  source: z
    .object({
      type: z.string().nullish(),
      id: id.nullish(),
      subject: z.string().nullish(),
      body: z.string().nullish(),
      delivered_as: z.string().nullish(),
      author: zAuthor,
    })
    .nullish(),
  tags: z.object({ tags: z.array(z.object({ id, name: z.string() })) }).nullish(),
  ticket: zTicketRef,
  conversation_parts: z.object({ conversation_parts: z.array(zPart) }).nullish(),
});
type ZConversation = z.infer<typeof zConversation>;

const zSearch = z.object({
  conversations: z.array(zConversation),
  pages: z
    .object({ next: z.object({ starting_after: z.string().nullish() }).nullish() })
    .loose()
    .nullish(),
});
const zArticle = z.object({
  id,
  title: z.string().nullish(),
  body: z.string().nullish(),
  state: z.string().nullish(),
  url: z.string().nullish(),
  default_locale: z.string().nullish(),
  updated_at: z.number(),
});
const zArticles = z.object({
  data: z.array(zArticle),
  pages: z.object({ page: z.number().nullish(), total_pages: z.number().nullish() }).loose().nullish(),
});
/** Pages of articles we read at most (50 per page). */
const MAX_ARTICLE_PAGES = 200;

const zMe = z.object({
  id,
  name: z.string().nullish(),
  app: z.object({ name: z.string().nullish(), id_code: z.string() }).loose().nullish(),
});
const zWebhook = z.object({
  type: z.literal("notification_event"),
  topic: z.string(),
  data: z.object({ item: z.object({ type: z.string(), id: id.nullish() }).loose().nullish() }).loose(),
});

function roleFor(type: string | null | undefined): AuthorRole {
  switch (type) {
    case "admin":
    case "team":
      return "agent";
    case "bot":
      return "bot";
    case "user":
    case "lead":
    case "contact":
      return "requester";
    default:
      return "system";
  }
}

const STATUS_PARTS: Record<string, string> = { open: "open", close: "closed", snoozed: "snoozed", unsnoozed: "open" };
/** Parts whose body (when present) is a message visible to the customer. */
const REPLY_PARTS = new Set(["comment", "assignment", "open", "close", "snoozed", "away_mode_assignment"]);

/** Raw status we map: the ticket's state category when the conversation carries a ticket. */
function rawStatusOf(c: ZConversation): string {
  const t = c.ticket;
  if (t) {
    const ts = t.ticket_state;
    if (typeof ts === "string") return ts;
    if (ts?.category) return ts.category;
    if (t.state) return t.state;
  }
  return c.state;
}

const sec = (s: number) => new Date(s * 1000);

export const intercom: ConnectorDefinition<IntercomCredentials> = {
  provider: "intercom",
  displayName: "Intercom",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    {
      key: "accessToken",
      label: "Access token",
      secret: true,
      help: "Developer Hub → your app → Authentication → Access token",
    },
    { key: "adminId", label: "Admin ID (optional)", secret: false, help: "Admin that notes and replies are sent as" },
  ],
  supportsWebhooks: true,
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations",
  supportsKnowledge: true,
  create(ctx: ConnectorContext<IntercomCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const region = (ctx.config as { region?: unknown })?.region;
    const baseUrl =
      region === "eu"
        ? "https://api.eu.intercom.io"
        : region === "au"
          ? "https://api.au.intercom.io"
          : "https://api.intercom.io";
    const http = new HttpClient({
      baseUrl,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Intercom-Version": INTERCOM_VERSION },
    });
    let adminId: string | null = creds.adminId ?? null;
    const me = async () => parseAs(zMe, await http.get("/me"), "me");
    const admin = async () => {
      if (!adminId) adminId = (await me()).id;
      return adminId;
    };
    const cid = (s: string) => encodeURIComponent(s);

    const snapshot = (c: ZConversation): CanonicalTicket => {
      const raw = rawStatusOf(c);
      const m = mappingIssues(ctx.mapping, raw, c.priority ?? null);
      const author = c.source?.author;
      const isRequester = roleFor(author?.type) === "requester";
      return {
        ref: { sourceId: c.id, displayKey: `#${c.id}`, url: null },
        subject: c.title ?? c.source?.subject ?? htmlToText(c.source?.body, 120),
        status: m.status,
        rawStatus: raw,
        priority: m.priority,
        rawPriority: c.priority ?? null,
        requester: {
          sourceId: isRequester ? (author?.id ?? null) : null,
          email: isRequester ? (author?.email ?? null) : null,
          name: isRequester ? (author?.name ?? null) : null,
          orgSourceId: null,
          orgName: null,
        },
        assignee: c.admin_assignee_id ? { sourceId: c.admin_assignee_id, name: null } : null,
        groupSourceId: c.team_assignee_id ?? null,
        tags: (c.tags?.tags ?? []).map((t) => t.name),
        channel: c.source?.delivered_as ?? c.source?.type ?? null,
        createdAt: sec(c.created_at),
        updatedAt: sec(c.updated_at),
        mappingIssues: m.issues,
      };
    };

    const buildHistory = (c: ZConversation) => {
      const key = (...p: string[]) => ["intercom", "conversation", c.id, ...p].join(":");
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];
      const created = sec(c.created_at);
      events.push({
        type: "created",
        at: created,
        status: "new",
        // No priority history in 2.16: the current priority is the best we have.
        priority: mapPriority(ctx.mapping, c.priority ?? null).value,
        idempotencyKey: key("created"),
      });
      const src = c.source;
      if (src && (src.body ?? "") !== "") {
        const role = roleFor(src.author?.type);
        const sid = src.id ?? `${c.id}-source`;
        events.push({
          type: "comment",
          at: created,
          author: openingEventAuthor(role),
          public: true,
          commentSourceId: sid,
          idempotencyKey: key("source"),
        });
        comments.push({
          sourceId: sid,
          at: created,
          authorRole: role,
          authorName: src.author?.name ?? null,
          authorSourceId: src.author?.id ?? null,
          public: true,
          bodyText: htmlToText(src.body),
        });
      }
      const parts = [...(c.conversation_parts?.conversation_parts ?? [])].sort(
        (a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id),
      );
      for (const p of parts) {
        const at = sec(p.created_at);
        const k = key("part", p.id);
        const role = roleFor(p.author?.type);
        const hasBody = (p.body ?? "").trim() !== "";
        const isNote = p.part_type === "note";
        if (hasBody && (isNote || REPLY_PARTS.has(p.part_type))) {
          const pub = !isNote;
          events.push({ type: "comment", at, author: role, public: pub, commentSourceId: p.id, idempotencyKey: k });
          comments.push({
            sourceId: p.id,
            at,
            authorRole: role,
            authorName: p.author?.name ?? null,
            authorSourceId: p.author?.id ?? null,
            public: pub,
            bodyText: htmlToText(p.body),
          });
        }
        const rawStatus = STATUS_PARTS[p.part_type];
        if (rawStatus) {
          events.push({
            type: "status_changed",
            at,
            status: mapStatus(ctx.mapping, rawStatus).value,
            rawStatus,
            idempotencyKey: `${k}:status`,
          });
        }
        if (p.part_type === "assignment" || p.part_type === "away_mode_assignment") {
          const to = p.assigned_to;
          events.push({
            type: "assignee_changed",
            at,
            assigneeSourceId: to?.type === "admin" ? (to.id ?? null) : null,
            idempotencyKey: `${k}:assignee`,
          });
        }
      }
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    const reply = async (sourceId: string, body: string, messageType: "note" | "comment") => {
      const r = parseAs(
        zConversation.partial().extend({
          conversation_parts: z.object({ conversation_parts: z.array(z.object({ id }).loose()) }).nullish(),
        }),
        await http.post(`/conversations/${cid(sourceId)}/reply`, {
          message_type: messageType,
          type: "admin",
          admin_id: await admin(),
          body,
        }),
        "reply",
      );
      return { commentSourceId: r.conversation_parts?.conversation_parts.at(-1)?.id ?? null };
    };

    return {
      async testConnection() {
        const m = await me();
        adminId ??= m.id;
        return { accountName: m.app?.name ?? "Intercom", accountId: m.app?.id_code ?? m.id };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { after: string } => typeof (v as { after?: unknown })?.after === "string";
        const state = decodeCursor(cursor, isState);
        const data = parseAs(
          zSearch,
          await http.post("/conversations/search", {
            // ">" is strict, so step back a second to include `since` itself.
            query: { field: "updated_at", operator: ">", value: Math.floor(since.getTime() / 1000) - 1 },
            pagination: state ? { per_page: 150, starting_after: state.after } : { per_page: 150 },
          }),
          "search conversations",
        );
        const next = data.pages?.next?.starting_after;
        return { items: data.conversations.map(snapshot), nextCursor: next ? encodeCursor({ after: next }) : null };
      },

      async getTicketWithHistory(sourceId) {
        const c = parseAs(
          zConversation,
          await http.get(`/conversations/${cid(sourceId)}`, { query: { display_as: "plaintext" } }),
          "conversation",
        );
        const { events, comments } = buildHistory(c);
        return { ticket: snapshot(c), events, comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const sig = header(req.headers, "x-hub-signature");
        if (
          !verifyHmac({ algo: "sha1", secret, payload: req.rawBody, signature: sig, encoding: "hex", prefix: "sha1=" })
        ) {
          return { ok: false, reason: "bad_signature" };
        }
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const item = parsed.data.data.item;
        // Ticket topics carry the ticket object; its id is used as the conversation id (see caveats).
        if (item && (item.type === "conversation" || item.type === "ticket") && item.id) {
          return { ok: true, ticketSourceIds: [item.id] };
        }
        return { ok: true, ticketSourceIds: [] };
      },

      async listKnowledgeArticles(cursor) {
        const isState = (v: unknown): v is { p: number } => typeof (v as { p?: unknown })?.p === "number";
        const page = decodeCursor(cursor, isState)?.p ?? 1;
        const data = parseAs(zArticles, await http.get("/articles", { query: { page, per_page: 50 } }), "articles");
        const items: KnowledgeArticle[] = data.data
          .filter((a) => a.state === "published")
          .map((a) => ({
            sourceId: a.id,
            title: a.title ?? "",
            url: a.url ?? null,
            bodyText: htmlToText(a.body),
            locale: a.default_locale ?? null,
            updatedAt: sec(a.updated_at),
          }));
        const total = data.pages?.total_pages ?? page;
        const more = page < total && page < MAX_ARTICLE_PAGES;
        return { items, nextCursor: more ? encodeCursor({ p: page + 1 }) : null };
      },

      postInternalNote(sourceId, body) {
        return reply(sourceId, body, "note");
      },

      postPublicReply(sourceId, body) {
        return reply(sourceId, body, "comment");
      },

      async updateTicket(sourceId, patch) {
        const a = await admin();
        if (patch.assigneeSourceId !== undefined) {
          await http.post(`/conversations/${cid(sourceId)}/parts`, {
            message_type: "assignment",
            type: "admin",
            admin_id: a,
            assignee_id: patch.assigneeSourceId,
          });
        }
        if (patch.priority) {
          // Priority is response-only in 2.16; the Preview version accepts it on update.
          await http.put(
            `/conversations/${cid(sourceId)}`,
            { priority: rawPriorityFor(ctx.mapping, patch.priority) ?? patch.priority, admin_id: a },
            { headers: { "Intercom-Version": "Preview" } },
          );
        }
        for (const name of patch.addTags ?? []) {
          const tag = parseAs(z.object({ id }).loose(), await http.post("/tags", { name }), "tag");
          await http.post(`/conversations/${cid(sourceId)}/tags`, { id: tag.id, admin_id: a });
        }
      },
    };
  },
};
