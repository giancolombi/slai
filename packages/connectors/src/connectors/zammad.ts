/**
 * Zammad connector (self-hosted or hosted).
 *
 * API docs (verified 2026-09):
 * - Intro, auth (`Authorization: Token token=…`), search params: https://docs.zammad.org/en/latest/api/intro.html
 * - Tickets: https://docs.zammad.org/en/latest/api/ticket/index.html
 * - Articles: https://docs.zammad.org/en/latest/api/ticket/articles.html
 * - Tags: https://docs.zammad.org/en/latest/api/ticket/tags.html
 * - Webhook payload + X-Hub-Signature: https://admin-docs.zammad.org/en/latest/manage/webhook/payload.html
 * - Knowledge base (`POST /api/v1/knowledge_bases/init`, answers with `include_contents`):
 *   https://docs.zammad.org/en/latest/api/knowledgebase.html and
 *   https://docs.zammad.org/en/latest/api/knowledgebase/answers.html
 * - Text modules (`GET /api/v1/text_modules`, page/per_page, bare array) are not in the API
 *   docs; see app/controllers/text_modules_controller.rb and
 *   https://admin-docs.zammad.org/en/latest/manage/text-modules.html
 *   and https://admin-docs.zammad.org/en/latest/manage/webhook.html
 * - Ticket history (`GET /api/v1/ticket_history/{id}`) is not in the API docs;
 *   its shape was verified from Zammad's source (tickets_controller#ticket_history).
 *
 * History comes from the ticket history log (state, priority, owner, tags) plus
 * articles (sender Customer/Agent/System, internal flag). System-sender
 * articles (trigger auto-replies) are treated as bot replies.
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, verifyHmac } from "../lib/hmac.js";
import { forbiddenAsUnsupported, HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText, plainText, savedReplyText } from "../lib/text.js";
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
  baseUrl: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
  apiToken: z.string().min(1),
});
export type ZammadCredentials = z.infer<typeof credentialsSchema>;

const configSchema = z.object({ pageSize: z.number().int().min(1).max(500).default(100) }).loose();

const defaultMapping: FieldMapping = {
  status: {
    new: "new",
    open: "open",
    "pending reminder": "pending",
    "pending close": "pending",
    closed: "closed",
    merged: "closed",
    removed: "closed",
  },
  priority: { "1 low": "low", "2 normal": "normal", "3 high": "high" },
};

const id = z.union([z.number(), z.string()]).transform(String);
const zTicket = z.object({
  id,
  number: z.union([z.string(), z.number()]).transform(String).nullish(),
  title: z.string().nullish(),
  state: z.string().nullish(),
  state_id: id.nullish(),
  priority: z.string().nullish(),
  customer_id: id.nullish(),
  customer: z.string().nullish(),
  owner_id: id.nullish(),
  owner: z.string().nullish(),
  organization_id: id.nullish(),
  organization: z.string().nullish(),
  group_id: id.nullish(),
  create_article_type: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
});
type ZTicket = z.infer<typeof zTicket>;

const zHistory = z.object({
  history: z.array(
    z
      .object({
        id,
        object: z.string().nullish(),
        history_object: z.string().nullish(),
        type: z.string().nullish(),
        history_type: z.string().nullish(),
        attribute: z.string().nullish(),
        history_attribute: z.string().nullish(),
        value_from: z.string().nullish(),
        value_to: z.string().nullish(),
        id_from: id.nullish(),
        id_to: id.nullish(),
        created_at: z.string(),
      })
      .transform((h) => ({
        id: h.id,
        object: h.object ?? h.history_object ?? null,
        type: h.type ?? h.history_type ?? null,
        attribute: h.attribute ?? h.history_attribute ?? null,
        valueFrom: h.value_from ?? null,
        valueTo: h.value_to ?? null,
        idTo: h.id_to ?? null,
        createdAt: h.created_at,
      })),
  ),
});

const zArticle = z.object({
  id,
  sender: z.string().nullish(),
  internal: z.boolean().nullish(),
  type: z.string().nullish(),
  body: z.string().nullish(),
  content_type: z.string().nullish(),
  from: z.string().nullish(),
  created_by_id: id.nullish(),
  created_at: z.string(),
});

const zWebhook = z.object({ ticket: z.object({ id }).loose() }).loose();

const zTextModule = z
  .object({
    id,
    name: z.string().nullish(),
    content: z.string().nullish(),
    active: z.boolean().nullish(),
    updated_at: z.string(),
  })
  .loose();
/** Text modules per page; the endpoint returns a bare array, so a short page is the last. */
const TEXT_MODULE_PAGE = 100;

/** Knowledge-base assets, keyed by model name and then by id (parsed leniently: the format is Zammad's own). */
const assetsOf = <T extends z.ZodType>(item: T) => z.record(z.string(), item).nullish();
const zKbAssets = z
  .object({
    KnowledgeBase: assetsOf(z.object({ id, custom_address: z.string().nullish() }).loose()),
    KnowledgeBaseLocale: assetsOf(
      z.object({ id, knowledge_base_id: id.nullish(), system_locale_id: id, primary: z.boolean().nullish() }).loose(),
    ),
    KnowledgeBaseCategory: assetsOf(z.object({ id, knowledge_base_id: id.nullish() }).loose()),
    KnowledgeBaseCategoryTranslation: assetsOf(
      z.object({ id, title: z.string().nullish(), kb_locale_id: id, category_id: id }).loose(),
    ),
    KnowledgeBaseAnswer: assetsOf(
      z
        .object({
          id,
          category_id: id,
          published_at: z.string().nullish(),
          internal_at: z.string().nullish(),
          archived_at: z.string().nullish(),
        })
        .loose(),
    ),
    KnowledgeBaseAnswerTranslation: assetsOf(
      z
        .object({
          id,
          title: z.string().nullish(),
          kb_locale_id: id,
          answer_id: id,
          content_id: id,
          updated_at: z.string().nullish(),
        })
        .loose(),
    ),
    KnowledgeBaseAnswerTranslationContent: assetsOf(z.object({ id, body: z.string().nullish() }).loose()),
  })
  .loose();
type KbAssets = z.infer<typeof zKbAssets>;
/** `init` returns the assets map itself; the answer endpoint wraps it as `{id, assets}`. */
const zKbResponse = z.union([z.object({ assets: zKbAssets }).loose(), zKbAssets.transform((assets) => ({ assets }))]);
const zLocales = z.array(z.object({ id, locale: z.string() }).loose());
/** Answer translations per page of the knowledge sync (one request each for the body). */
const KB_PAGE = 20;

/** A timestamp that has passed (scheduled publishing or archiving sets future ones). */
const passed = (t: string | null | undefined, now: number) => !!t && Date.parse(t) <= now;

/** The part of a Zammad public URL after the id; Zammad resolves `/{id}-{slug}` by the leading id. */
const slug = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

interface KbEntry {
  kbId: string;
  answerId: string;
  contentId: string;
  translationId: string;
  title: string;
  locale: string;
  url: string | null;
  updatedAt: string | null;
}

/**
 * Publicly published answer translations, in translation-id order. Internal-only,
 * draft, archived and scheduled answers are left out: drafts go to customers.
 */
function publicAnswers(a: KbAssets, locales: Map<string, string>, baseUrl: string, now: number): KbEntry[] {
  const kbLocales = a.KnowledgeBaseLocale ?? {};
  const categories = a.KnowledgeBaseCategory ?? {};
  const categoryTitle = (categoryId: string, kbLocaleId: string) =>
    Object.values(a.KnowledgeBaseCategoryTranslation ?? {}).find(
      (t) => t.category_id === categoryId && t.kb_locale_id === kbLocaleId,
    )?.title;
  const out: KbEntry[] = [];
  for (const t of Object.values(a.KnowledgeBaseAnswerTranslation ?? {})) {
    const answer = a.KnowledgeBaseAnswer?.[t.answer_id];
    if (!answer || !passed(answer.published_at, now) || passed(answer.archived_at, now)) continue;
    const kbLocale = kbLocales[t.kb_locale_id];
    const locale = kbLocale ? locales.get(kbLocale.system_locale_id) : undefined;
    const kbId = kbLocale?.knowledge_base_id ?? categories[answer.category_id]?.knowledge_base_id;
    if (!locale || !kbId) continue;
    // A custom address that is a path lives on the Zammad host. One on another domain can't be
    // resolved reliably from the API, so those answers carry no URL rather than a wrong one.
    const custom = a.KnowledgeBase?.[kbId]?.custom_address?.trim();
    const root = !custom
      ? `${baseUrl}/help`
      : custom.startsWith("/")
        ? `${baseUrl}${custom.replace(/\/+$/, "")}`
        : null;
    const category = `${answer.category_id}-${slug(categoryTitle(answer.category_id, t.kb_locale_id))}`;
    out.push({
      kbId,
      answerId: answer.id,
      contentId: t.content_id,
      translationId: t.id,
      title: t.title ?? "",
      locale,
      url: root ? `${root}/${locale}/${category}/${answer.id}-${slug(t.title)}` : null,
      updatedAt: t.updated_at ?? null,
    });
  }
  return out.sort((x, y) => Number(x.translationId) - Number(y.translationId));
}

function senderRole(sender: string | null | undefined): AuthorRole {
  switch ((sender ?? "").toLowerCase()) {
    case "customer":
      return "requester";
    case "system":
      return "bot";
    default:
      return "agent";
  }
}

export const zammad: ConnectorDefinition<ZammadCredentials> = {
  provider: "zammad",
  displayName: "Zammad",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    { key: "baseUrl", label: "Zammad URL", secret: false, placeholder: "https://support.acme.com" },
    {
      key: "apiToken",
      label: "Access token",
      secret: true,
      help: "Profile → Token Access. Needs ticket.agent (and admin.tag for tags).",
    },
  ],
  supportsWebhooks: true,
  webhookSetup: {
    secret: "slai",
    steps: [
      "Settings → Manage → Webhook → New Webhook, endpoint {url}, HMAC SHA1 signature token {secret}.",
      "Settings → Manage → Trigger → New Trigger: on ticket create and update, action Webhook → the webhook above.",
    ],
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://docs.zammad.org/en/latest/api/intro.html",
  supportsKnowledge: true,
  supportsSavedReplies: true,
  create(ctx: ConnectorContext<ZammadCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const cfg = configSchema.parse(ctx.config ?? {});
    const host = new URL(creds.baseUrl).host;
    const http = new HttpClient({
      baseUrl: creds.baseUrl,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: `Token token=${creds.apiToken}` },
    });
    const key = (...parts: (string | number)[]) => ["zammad", host, ...parts].join(":");

    const snapshot = (t: ZTicket, tags: string[]): CanonicalTicket => {
      const rawStatus = t.state ?? "open";
      const m = mappingIssues(ctx.mapping, rawStatus, t.priority ?? null);
      return {
        ref: {
          sourceId: t.id,
          displayKey: t.number ? `#${t.number}` : `#${t.id}`,
          url: `${creds.baseUrl}/#ticket/zoom/${t.id}`,
        },
        subject: t.title ?? "",
        status: m.status,
        rawStatus,
        priority: m.priority,
        rawPriority: t.priority ?? null,
        requester: {
          sourceId: t.customer_id ?? null,
          email: t.customer?.includes("@") ? t.customer : null,
          name: null,
          orgSourceId: t.organization_id ?? null,
          orgName: t.organization ?? null,
        },
        // Zammad's unassigned owner is user id 1 ("-").
        assignee: t.owner_id && t.owner_id !== "1" ? { sourceId: t.owner_id, name: t.owner ?? null } : null,
        groupSourceId: t.group_id ?? null,
        tags,
        channel: t.create_article_type ?? null,
        createdAt: parseTime(t.created_at, "ticket.created_at"),
        updatedAt: parseTime(t.updated_at, "ticket.updated_at"),
        mappingIssues: m.issues,
      };
    };

    const getTicket = async (sourceId: string) =>
      parseAs(
        zTicket,
        await http.get(`/api/v1/tickets/${encodeURIComponent(sourceId)}`, { query: { expand: true } }),
        "ticket",
      );

    return {
      async testConnection() {
        const me = parseAs(
          z.object({ id, email: z.string().nullish() }),
          await http.get("/api/v1/users/me"),
          "users/me",
        );
        if (!me.id) throw new ConnectorError("Zammad: not authenticated", "auth");
        return { accountName: host, accountId: host };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { page: number } => typeof (v as { page?: unknown })?.page === "number";
        const page = decodeCursor(cursor, isState)?.page ?? 1;
        const data = parseAs(
          z.array(zTicket),
          await http.get("/api/v1/tickets/search", {
            query: {
              query: `updated_at:["${since.toISOString()}" TO *]`,
              sort_by: "updated_at",
              order_by: "asc",
              expand: true,
              page,
              per_page: cfg.pageSize,
            },
          }),
          "ticket search",
        );
        return {
          // The search index only carries tag names in the full ticket; see getTicketWithHistory.
          items: data.filter((t) => Date.parse(t.updated_at) >= since.getTime()).map((t) => snapshot(t, [])),
          nextCursor: data.length >= cfg.pageSize ? encodeCursor({ page: page + 1 }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const tid = encodeURIComponent(sourceId);
        const ticket = await getTicket(sourceId);
        const hist = parseAs(zHistory, await http.get(`/api/v1/ticket_history/${tid}`), "ticket history").history;
        const articles = parseAs(
          z.array(zArticle),
          await http.get(`/api/v1/ticket_articles/by_ticket/${tid}`),
          "articles",
        );
        const tags = parseAs(
          z.object({ tags: z.array(z.string()) }),
          await http.get("/api/v1/tags", { query: { object: "Ticket", o_id: sourceId } }),
          "tags",
        ).tags;

        const ticketHist = hist
          .filter((h) => h.object === "Ticket")
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || Number(a.id) - Number(b.id));
        const firstFrom = (attr: string) =>
          ticketHist.find((h) => h.type === "updated" && h.attribute === attr)?.valueFrom;
        const createdAt = parseTime(
          ticketHist.find((h) => h.type === "created")?.createdAt ?? ticket.created_at,
          "ticket created",
        );
        const events: CanonicalEvent[] = [
          {
            type: "created",
            at: createdAt,
            status: mapStatus(ctx.mapping, firstFrom("state") ?? ticket.state ?? "new").value,
            priority: mapPriority(ctx.mapping, firstFrom("priority") ?? ticket.priority ?? null).value,
            idempotencyKey: key("ticket", ticket.id, "created"),
          },
        ];
        let tagSet: string[] = [];
        for (const h of ticketHist) {
          const at = parseTime(h.createdAt, `history ${h.id}`);
          const k = key("history", h.id);
          if (h.type === "updated" && h.attribute === "state" && h.valueTo) {
            events.push({
              type: "status_changed",
              at,
              status: mapStatus(ctx.mapping, h.valueTo).value,
              rawStatus: h.valueTo,
              idempotencyKey: k,
            });
          } else if (h.type === "updated" && h.attribute === "priority") {
            events.push({
              type: "priority_changed",
              at,
              priority: mapPriority(ctx.mapping, h.valueTo).value,
              rawPriority: h.valueTo,
              idempotencyKey: k,
            });
          } else if (h.type === "updated" && h.attribute === "owner") {
            events.push({
              type: "assignee_changed",
              at,
              assigneeSourceId: h.idTo && h.idTo !== "1" ? h.idTo : null,
              idempotencyKey: k,
            });
          } else if ((h.type === "added" || h.type === "removed") && h.attribute === "tag" && h.valueTo) {
            tagSet = h.type === "added" ? [...new Set([...tagSet, h.valueTo])] : tagSet.filter((x) => x !== h.valueTo);
            events.push({ type: "tags_changed", at, tags: tagSet, idempotencyKey: k });
          }
        }

        const comments: CanonicalComment[] = [];
        const sortedArticles = [...articles].sort(
          (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id),
        );
        sortedArticles.forEach((a, i) => {
          const at = parseTime(a.created_at, `article ${a.id}`);
          const role = senderRole(a.sender);
          const pub = a.internal !== true;
          events.push({
            type: "comment",
            at,
            author: i === 0 ? openingEventAuthor(role) : role,
            public: pub,
            commentSourceId: a.id,
            idempotencyKey: key("article", a.id),
          });
          comments.push({
            sourceId: a.id,
            at,
            authorRole: role,
            authorName: a.from ?? null,
            authorSourceId: a.created_by_id ?? null,
            public: pub,
            bodyText: (a.content_type ?? "").includes("html") ? htmlToText(a.body) : plainText(a.body),
          });
        });

        return { ticket: snapshot(ticket, tags), events: dropNoopChanges(finalizeEvents(events)), comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const ok = verifyHmac({
          algo: "sha1",
          secret,
          payload: req.rawBody,
          signature: header(req.headers, "x-hub-signature"),
          encoding: "hex",
          prefix: "sha1=",
        });
        if (!ok) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [parsed.data.ticket.id] };
      },

      async listSavedReplies(cursor) {
        const isState = (v: unknown): v is { page: number } => typeof (v as { page?: unknown })?.page === "number";
        const page = decodeCursor(cursor, isState)?.page ?? 1;
        const modules = await forbiddenAsUnsupported("Zammad text modules", async () =>
          parseAs(
            z.array(zTextModule),
            await http.get("/api/v1/text_modules", { query: { page, per_page: TEXT_MODULE_PAGE } }),
            "text modules",
          ),
        );
        const items: KnowledgeArticle[] = modules
          .filter((m) => m.active !== false)
          .map((m) => ({
            sourceId: m.id,
            title: m.name ?? "",
            url: null,
            bodyText: savedReplyText(m.content, "html"),
            locale: null,
            updatedAt: parseTime(m.updated_at, `text module ${m.id}.updated_at`),
          }));
        return { items, nextCursor: modules.length >= TEXT_MODULE_PAGE ? encodeCursor({ page: page + 1 }) : null };
      },

      async listKnowledgeArticles(cursor) {
        const isState = (v: unknown): v is { i: number } => typeof (v as { i?: unknown })?.i === "number";
        const start = decodeCursor(cursor, isState)?.i ?? 0;
        return forbiddenAsUnsupported("Zammad knowledge base", async () => {
          // Each page re-reads the index (ids and titles, no bodies), so the cursor stays one number.
          let init: KbAssets;
          try {
            init = parseAs(zKbResponse, await http.post("/api/v1/knowledge_bases/init", {}), "knowledge base").assets;
          } catch (e) {
            // No knowledge base (or the feature is off): nothing to sync.
            if (e instanceof ConnectorError && e.kind === "not_found") return { items: [], nextCursor: null };
            throw e;
          }
          if (!Object.keys(init.KnowledgeBaseAnswerTranslation ?? {}).length) return { items: [], nextCursor: null };
          const locales = new Map(
            parseAs(zLocales, await http.get("/api/v1/locales"), "locales").map((l) => [l.id, l.locale.toLowerCase()]),
          );
          const all = publicAnswers(init, locales, creds.baseUrl, Date.now());
          const items: KnowledgeArticle[] = [];
          for (const e of all.slice(start, start + KB_PAGE)) {
            const res = parseAs(
              zKbResponse,
              await http.get(
                `/api/v1/knowledge_bases/${encodeURIComponent(e.kbId)}/answers/${encodeURIComponent(e.answerId)}`,
                { query: { include_contents: e.contentId } },
              ),
              `knowledge base answer ${e.answerId}`,
            );
            const translation = res.assets.KnowledgeBaseAnswerTranslation?.[e.translationId];
            const updated = translation?.updated_at ?? e.updatedAt;
            items.push({
              sourceId: `${e.answerId}:${e.locale}`,
              title: translation?.title ?? e.title,
              url: e.url,
              bodyText: htmlToText(res.assets.KnowledgeBaseAnswerTranslationContent?.[e.contentId]?.body),
              locale: e.locale,
              updatedAt: updated ? parseTime(updated, `answer ${e.answerId}.updated_at`) : new Date(0),
            });
          }
          const next = start + KB_PAGE;
          return { items, nextCursor: next < all.length ? encodeCursor({ i: next }) : null };
        });
      },

      async postInternalNote(sourceId, body) {
        const r = parseAs(
          z.object({ id }),
          await http.post("/api/v1/ticket_articles", {
            ticket_id: Number(sourceId),
            body,
            content_type: "text/plain",
            type: "note",
            internal: true,
          }),
          "article",
        );
        return { commentSourceId: r.id };
      },

      async postPublicReply(sourceId, body) {
        const t = await getTicket(sourceId);
        if (!t.customer_id) throw new ConnectorError(`Zammad ticket ${sourceId} has no customer`, "invalid");
        const customer = parseAs(
          z.object({ email: z.string().nullish() }),
          await http.get(`/api/v1/users/${encodeURIComponent(t.customer_id)}`),
          "customer",
        );
        if (!customer.email) throw new ConnectorError(`Zammad customer ${t.customer_id} has no email`, "invalid");
        const r = parseAs(
          z.object({ id }),
          await http.post("/api/v1/ticket_articles", {
            ticket_id: Number(sourceId),
            to: customer.email,
            subject: t.title ?? "",
            body,
            content_type: "text/plain",
            type: "email",
            internal: false,
          }),
          "article",
        );
        return { commentSourceId: r.id };
      },

      async updateTicket(sourceId, patch) {
        const tid = encodeURIComponent(sourceId);
        const update: Record<string, unknown> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (!raw) throw new ConnectorError(`no Zammad priority is mapped to "${patch.priority}"`, "invalid");
          update.priority = raw;
        }
        if (patch.assigneeSourceId !== undefined) update.owner_id = Number(patch.assigneeSourceId);
        if (Object.keys(update).length > 0) await http.put(`/api/v1/tickets/${tid}`, update);
        for (const item of patch.addTags ?? []) {
          await http.post("/api/v1/tags/add", { object: "Ticket", o_id: Number(sourceId), item });
        }
      },
    };
  },
};
