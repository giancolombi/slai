/**
 * Zammad connector (self-hosted or hosted).
 *
 * API docs (verified 2026-09):
 * - Intro, auth (`Authorization: Token token=…`), search params: https://docs.zammad.org/en/latest/api/intro.html
 * - Tickets: https://docs.zammad.org/en/latest/api/ticket/index.html
 * - Articles: https://docs.zammad.org/en/latest/api/ticket/articles.html
 * - Tags: https://docs.zammad.org/en/latest/api/ticket/tags.html
 * - Webhook payload + X-Hub-Signature: https://admin-docs.zammad.org/en/latest/manage/webhook/payload.html
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
import { HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { decodeCursor, encodeCursor } from "../lib/paginate.js";
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
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://docs.zammad.org/en/latest/api/intro.html",
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
