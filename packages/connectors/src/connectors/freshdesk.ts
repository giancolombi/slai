/**
 * Freshdesk connector.
 *
 * API docs (verified 2026-09):
 * - API v2 reference (auth, tickets, conversations, notes, reply, rate limits): https://developers.freshdesk.com/api/
 * - List tickets (updated_since, include=requester,stats, 300-page cap, Link header): https://developers.freshdesk.com/api/#list_all_tickets
 * - Conversations: https://developers.freshdesk.com/api/#list_all_ticket_notes
 * - Rate limits: https://support.freshdesk.com/support/solutions/articles/225439-what-are-the-rate-limits-for-the-api-calls-to-freshdesk-
 * - Solutions (categories → folders → articles; status 2 = published): https://developers.freshdesk.com/api/#solutions
 * - Solution subfolders (Flexible Hierarchy, `sub_folders_count`) and translated articles
 *   (`/solutions/folders/{id}/articles/{language_code}`): https://developers.freshdesk.com/api/#solutions
 * - Helpdesk settings (primary_language, portal_languages): https://developers.freshdesk.com/api/#settings
 * - Canned responses (folders; `/canned_response_folders/{id}/responses` includes bodies):
 *   https://developers.freshdesk.com/api/#canned-responses
 *
 * KNOWLEDGE — published solution articles from every folder and subfolder
 * customers can see (agents-only folders, visibility 3, are skipped), in the
 * primary language and every other language shown on the portal
 * (`portal_languages`). A translation's id is `{article id}:{language}`.
 * Article URLs use `{domain}.freshdesk.com` unless the connection sets
 * `config.portalDomain` (e.g. help.acme.com): the API does not expose the
 * portal's custom domain. Translations live under `/{language}/support/…`.
 * Saved replies are canned responses from shared folders (personal folders
 * belong to one agent and are skipped), with placeholders stripped.
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
import { basicAuth, forbiddenAsUnsupported, HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor, nextLink } from "../lib/paginate.js";
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

const zSolutionRef = z.object({ id });
const zSolutionFolder = z.object({
  id,
  visibility: z.number().nullish(),
  sub_folders_count: z.number().nullish(),
});
const zSolutionArticle = z.object({
  id,
  title: z.string().nullish(),
  description: z.string().nullish(),
  description_text: z.string().nullish(),
  status: z.number().nullish(),
  updated_at: z.string(),
});
/** Solution article status: 1 draft, 2 published. */
const PUBLISHED = 2;
/** Folder visibility 3: agents only. Those articles are internal, never for a customer reply. */
const AGENTS_ONLY = 3;
/** Folders (and pages per folder) we read at most in one knowledge sync, and how deep subfolders go. */
const MAX_FOLDERS = 1000;
const MAX_ARTICLE_PAGES = 100;
const MAX_FOLDER_DEPTH = 5;
/** A language code safe to put in a URL path, e.g. "de" or "pt-BR". */
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const zHelpdeskSettings = z.object({
  primary_language: z.string().nullish(),
  portal_languages: z.array(z.string()).nullish(),
});
const zCannedFolder = z.object({ id, personal: z.boolean().nullish() });
const zCannedResponse = z.object({
  id,
  title: z.string().nullish(),
  content: z.string().nullish(),
  content_html: z.string().nullish(),
  updated_at: z.string(),
});
/** A custom portal domain from the connection config, e.g. help.acme.com. */
const zPortalDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);

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
  webhookSetup: {
    secret: "slai",
    steps: [
      "Admin → Workflows → Automations → Ticket updates → New rule (add a second rule under Ticket creation).",
      "Action: Trigger webhook, POST, JSON, URL {url}.",
      "Add a custom header X-Slai-Webhook-Token: {secret}.",
      'Content: {"freshdesk_webhook": {"ticket_id": "{{ticket.id}}"}}.',
    ],
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developers.freshdesk.com/api/",
  supportsKnowledge: true,
  supportsSavedReplies: true,
  create(ctx: ConnectorContext<FreshdeskCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const domain = creds.domain;
    const portal = zPortalDomain.safeParse((ctx.config as { portalDomain?: unknown } | undefined)?.portalDomain);
    const portalHost = portal.success ? portal.data : `${domain}.freshdesk.com`;
    const http = new HttpClient({
      baseUrl: `https://${domain}.freshdesk.com`,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: basicAuth(creds.apiKey, "X") },
    });
    const key = (...parts: (string | number)[]) => ["freshdesk", domain, ...parts].join(":");

    /**
     * Every solution folder customers can see: each category's folders and,
     * breadth-first, their subfolders (Flexible Hierarchy), skipping
     * agents-only folders and everything below them.
     */
    const solutionFolders = async (): Promise<string[]> => {
      const categories = parseAs(
        z.array(zSolutionRef),
        await http.get("/api/v2/solutions/categories"),
        "solution categories",
      );
      let level: z.infer<typeof zSolutionFolder>[] = [];
      for (const c of categories) {
        level.push(
          ...parseAs(
            z.array(zSolutionFolder),
            await http.get(`/api/v2/solutions/categories/${encodeURIComponent(c.id)}/folders`),
            "solution folders",
          ),
        );
      }
      const out: string[] = [];
      for (let depth = 0; level.length && out.length < MAX_FOLDERS; depth++) {
        const next: typeof level = [];
        for (const f of level) {
          if (f.visibility === AGENTS_ONLY) continue;
          out.push(f.id);
          if (out.length >= MAX_FOLDERS) break;
          if ((f.sub_folders_count ?? 0) > 0 && depth + 1 < MAX_FOLDER_DEPTH) {
            next.push(
              ...parseAs(
                z.array(zSolutionFolder),
                await http.get(`/api/v2/solutions/folders/${encodeURIComponent(f.id)}/subfolders`),
                "solution subfolders",
              ),
            );
          }
        }
        level = next;
      }
      return out;
    };

    /**
     * The primary language first, then the other languages shown on the
     * portal. Reading settings needs an admin key; without it (or where the
     * endpoint is missing) we sync the primary language only, as "" (unknown).
     */
    const portalLanguages = async (): Promise<string[]> => {
      try {
        const s = parseAs(zHelpdeskSettings, await http.get("/api/v2/settings/helpdesk"), "helpdesk settings");
        const primary = s.primary_language && LANGUAGE.test(s.primary_language) ? s.primary_language : "";
        const others = (s.portal_languages ?? []).filter((l) => LANGUAGE.test(l) && l !== primary);
        return [primary, ...new Set(others)];
      } catch (e) {
        if (e instanceof ConnectorError && ["auth", "not_found", "invalid"].includes(e.kind)) return [""];
        throw e;
      }
    };

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

      async listKnowledgeArticles(cursor) {
        // Traversal state: folder ids and languages (found on the first call; l[0] is the primary
        // language, "" when unknown), then which language, which folder, and which page.
        const isState = (v: unknown): v is { f: string[]; l: string[]; j: number; i: number; p: number } => {
          const o = v as { f?: unknown; l?: unknown; j?: unknown; i?: unknown; p?: unknown } | null;
          return (
            Array.isArray(o?.f) &&
            Array.isArray(o.l) &&
            o.l.length > 0 &&
            o.l.every((x) => typeof x === "string" && (x === "" || LANGUAGE.test(x))) &&
            typeof o.j === "number" &&
            typeof o.i === "number" &&
            typeof o.p === "number"
          );
        };
        let state = decodeCursor(cursor, isState);
        if (!state) {
          const f = await solutionFolders();
          state = { f, l: await portalLanguages(), j: 0, i: 0, p: 1 };
        }
        const st = state;
        const folder = st.f[st.i];
        const lang = st.l[st.j];
        if (folder === undefined || lang === undefined) return { items: [], nextCursor: null };
        const primary = st.j === 0;
        const nextFolder = () =>
          st.i + 1 < st.f.length
            ? { ...st, i: st.i + 1, p: 1 }
            : st.j + 1 < st.l.length
              ? { ...st, j: st.j + 1, i: 0, p: 1 }
              : null;
        const path = `/api/v2/solutions/folders/${encodeURIComponent(folder)}/articles${primary ? "" : `/${encodeURIComponent(lang)}`}`;
        let res: { data: unknown; headers: Headers };
        try {
          res = await http.request<unknown>("GET", path, { query: { page: st.p, per_page: 100 } });
        } catch (e) {
          // A folder that is not translated into this language.
          if (!primary && e instanceof ConnectorError && e.kind === "not_found") {
            const next = nextFolder();
            return { items: [], nextCursor: next ? encodeCursor(next) : null };
          }
          throw e;
        }
        const articles = parseAs(z.array(zSolutionArticle), res.data, "solution articles");
        const items: KnowledgeArticle[] = articles
          .filter((a) => a.status === PUBLISHED)
          .map((a) => ({
            sourceId: primary ? a.id : `${a.id}:${lang}`,
            title: a.title ?? "",
            url: `https://${portalHost}${primary ? "" : `/${lang}`}/support/solutions/articles/${a.id}`,
            bodyText: a.description_text ? plainText(a.description_text) : htmlToText(a.description),
            locale: lang || null,
            updatedAt: parseTime(a.updated_at, `article ${a.id}.updated_at`),
          }));
        const hasNext = /;\s*rel="?next"?/i.test(res.headers.get("link") ?? "") && st.p < MAX_ARTICLE_PAGES;
        const next = hasNext ? { ...st, p: st.p + 1 } : nextFolder();
        return { items, nextCursor: next ? encodeCursor(next) : null };
      },

      async listSavedReplies(cursor) {
        return forbiddenAsUnsupported("Freshdesk canned responses", async () => {
          const isState = (v: unknown): v is { f: string[]; i: number } =>
            Array.isArray((v as { f?: unknown })?.f) && typeof (v as { i?: unknown })?.i === "number";
          let state = decodeCursor(cursor, isState);
          if (!state) {
            const folders = parseAs(
              z.array(zCannedFolder),
              await http.get("/api/v2/canned_response_folders"),
              "canned response folders",
            );
            // Personal folders are one agent's own replies, not the team's.
            state = { f: folders.filter((f) => f.personal !== true).map((f) => f.id), i: 0 };
          }
          const folder = state.f[state.i];
          if (folder === undefined) return { items: [], nextCursor: null };
          const responses = parseAs(
            z.array(zCannedResponse),
            await http.get(`/api/v2/canned_response_folders/${encodeURIComponent(folder)}/responses`),
            "canned responses",
          );
          const items: KnowledgeArticle[] = responses
            .map((r) => ({
              sourceId: r.id,
              title: r.title ?? "",
              url: null,
              bodyText: r.content_html ? savedReplyText(r.content_html, "html") : savedReplyText(r.content, "text"),
              locale: null,
              updatedAt: parseTime(r.updated_at, `canned response ${r.id}.updated_at`),
            }))
            .filter((r) => r.bodyText);
          const next = state.i + 1 < state.f.length ? { ...state, i: state.i + 1 } : null;
          return { items, nextCursor: next ? encodeCursor(next) : null };
        });
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
