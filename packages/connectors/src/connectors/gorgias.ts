/**
 * Gorgias connector (REST API, private-app API key).
 *
 * API docs (verified 2026-09):
 * - Auth (Basic `{email}:{api key}`): https://developers.gorgias.com/reference/authentication
 * - List tickets (cursor, limit ≤ 100, order_by updated_datetime:asc|desc, meta.next_cursor):
 *   https://developers.gorgias.com/reference/list-tickets
 * - Ticket object (status open|closed, priority low|normal|high|critical, snooze_datetime):
 *   https://developers.gorgias.com/reference/the-ticket-object
 * - Update ticket (PUT, priority, assignee_user {id}): https://developers.gorgias.com/reference/update-ticket
 * - List messages (GET /api/messages?ticket_id=…, order_by created_datetime:asc|desc):
 *   https://developers.gorgias.com/reference/list-messages
 * - Message object (from_agent, public, channel, via, rule_id, source): https://developers.gorgias.com/reference/the-ticketmessage-object
 * - Create message (channel "internal-note" → internal note; email sent when sent_datetime is empty):
 *   https://developers.gorgias.com/reference/create-ticket-message
 * - Add ticket tags (POST /api/tickets/{id}/tags {names}): https://developers.gorgias.com/reference/create-ticket-tags
 * - Events (GET /api/events?object_type=Ticket&object_id=…, type list): https://developers.gorgias.com/reference/list-events
 *   and https://developers.gorgias.com/reference/the-event-object
 * - Rate limits (429 + Retry-After): https://developers.gorgias.com/reference/limitations
 * - HTTP integrations (triggers, headers, {{ticket.id}} templates):
 *   https://docs.gorgias.com/en-US/connect-external-apps-to-gorgias-and-create-sidebar-widgets-81822
 * - Snoozing sets status to closed with snooze_datetime: https://docs.gorgias.com/en-US/snooze-tickets-404911
 * - Macros (saved replies; cursor, limit ≤ 100, meta.next_cursor; `archived_datetime`; the reply is the
 *   `setResponseText` action's arguments.body_html / body_text): https://developers.gorgias.com/reference/list-macros
 *   and https://developers.gorgias.com/reference/the-macro-object
 *
 * TIMESTAMPS — Gorgias returns naive ISO datetimes ("2019-11-16T15:59:41.966927")
 * that are UTC. JS would parse those as local time, so `utc()` appends "Z".
 *
 * STATUS — Gorgias has only open|closed. A snoozed ticket is `closed` with a
 * `snooze_datetime` (it reopens on its own or when the customer replies), so we
 * synthesize the raw status "snoozed" (→ pending: waiting on the requester).
 * `closed` maps to solved, not closed: a Gorgias closed ticket reopens when the
 * customer writes back, which is Zendesk's "solved" semantics.
 *
 * LISTING — there is no server-side "updated since" filter, so we page
 * `order_by=updated_datetime:desc` and stop at the first ticket older than
 * `since` (ascending order would scan the whole account every poll). A ticket
 * updated during the scan jumps to the front and is missed by this scan, but
 * its new updated_datetime is ≥ the scan start, so the next poll catches it.
 *
 * HISTORY — messages give comments (from_agent false → requester; true → agent,
 * or bot when the message was sent by a rule: `rule_id` set or via "rule";
 * via "api" counts as agent because integrations and slai post for agents;
 * `public` false or channel "internal-note" → internal). Status, assignee,
 * priority and tag transitions come from the Events API. Event type names are
 * documented; the `data` payload is NOT ("key-value data", no schema), so the
 * shapes parsed below (assignee id, priority old/new, tag names) are our best
 * reading and need confirmation against a real account. Events whose data we
 * can't read are skipped (the ticket snapshot still carries current values).
 * Snoozing may log both ticket-snoozed and ticket-closed; the closed event in
 * the same context (or at the same instant) is dropped so a snooze never reads
 * as a solve.
 *
 * WEBHOOKS — Gorgias HTTP integrations are unsigned. The customer adds an HTTP
 * integration (POST, application/json, triggers "Ticket created", "Ticket
 * updated", "Ticket message created", "Ticket self unsnoozed") with header
 * `X-Slai-Webhook-Secret: <secret>` and body {"ticket_id": "{{ticket.id}}"}.
 * The header is compared in constant time.
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, safeEqual } from "../lib/hmac.js";
import { basicAuth, forbiddenAsUnsupported, HttpClient } from "../lib/http.js";
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

const credentialsSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Just the subdomain, e.g. acme for acme.gorgias.com"),
  email: z.email(),
  apiKey: z.string().min(1),
});
export type GorgiasCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: { open: "open", snoozed: "pending", closed: "solved" },
  priority: { low: "low", normal: "normal", high: "high", critical: "urgent" },
};

const PAGE_LIMIT = 100;
export const WEBHOOK_SECRET_HEADER = "x-slai-webhook-secret";

const id = z.union([z.number(), z.string()]).transform(String);
const zRef = z.object({ id, name: z.string().nullish(), email: z.string().nullish() }).nullish();
const zTicket = z.object({
  id,
  subject: z.string().nullish(),
  status: z.string(),
  priority: z.string().nullish(),
  snooze_datetime: z.string().nullish(),
  channel: z.string().nullish(),
  customer: zRef,
  assignee_user: zRef,
  assignee_team: zRef,
  tags: z.array(z.object({ id: id.nullish(), name: z.string() })).nullish(),
  created_datetime: z.string(),
  updated_datetime: z.string(),
});
type GTicket = z.infer<typeof zTicket>;

const zMacro = z
  .object({
    id,
    name: z.string().nullish(),
    language: z.string().nullish(),
    archived_datetime: z.string().nullish(),
    created_datetime: z.string().nullish(),
    updated_datetime: z.string().nullish(),
    actions: z
      .array(
        z
          .object({
            name: z.string().nullish(),
            arguments: z.object({ body_text: z.string().nullish(), body_html: z.string().nullish() }).loose().nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();
const zMeta = z.object({ next_cursor: z.string().nullish() }).nullish();
const zAddress = z.object({ address: z.string().nullish(), name: z.string().nullish() });
const zMessage = z.object({
  id,
  channel: z.string().nullish(),
  via: z.string().nullish(),
  from_agent: z.boolean().nullish(),
  public: z.boolean().nullish(),
  rule_id: id.nullish(),
  subject: z.string().nullish(),
  sender: zRef,
  source: z.object({ type: z.string().nullish(), from: zAddress.nullish(), to: z.array(zAddress).nullish() }).nullish(),
  body_text: z.string().nullish(),
  body_html: z.string().nullish(),
  stripped_text: z.string().nullish(),
  created_datetime: z.string(),
});
type GMessage = z.infer<typeof zMessage>;
const zEvent = z.object({
  id,
  type: z.string(),
  context: z.string().nullish(),
  user_id: id.nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
  created_datetime: z.string(),
});
type GEvent = z.infer<typeof zEvent>;
const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), meta: zMeta });

const zWebhook = z.object({ ticket_id: id }).loose();

/** Naive Gorgias datetimes are UTC; make that explicit before parsing. */
function utc(v: string | null | undefined): string | null | undefined {
  if (!v) return v;
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v}Z`;
}

function rawStatusOf(t: Pick<GTicket, "status" | "snooze_datetime">): string {
  return t.status === "closed" && t.snooze_datetime ? "snoozed" : t.status;
}

function messageRole(m: GMessage): AuthorRole {
  if (m.from_agent !== true) return "requester";
  if (m.rule_id || m.via === "rule") return "bot";
  return "agent";
}

/** Undocumented event data (see header): an assignee user id, or null for unassign. */
function eventAssignee(data: Record<string, unknown>): string | null | undefined {
  const direct = data.assignee_user_id;
  if (typeof direct === "number" || typeof direct === "string") return String(direct);
  const nested = data.assignee_user;
  if (nested === null) return null;
  const nid = (nested as { id?: unknown } | undefined)?.id;
  if (typeof nid === "number" || typeof nid === "string") return String(nid);
  return undefined;
}

/** Undocumented event data: priority as "high" or {old, new}. */
function eventPriority(data: Record<string, unknown>): { from: string | null | undefined; to: string } | null {
  const p = data.priority;
  if (typeof p === "string") return { from: undefined, to: p };
  const o = p as { old?: unknown; new?: unknown } | undefined;
  if (o && typeof o.new === "string") return { from: typeof o.old === "string" ? o.old : undefined, to: o.new };
  return null;
}

/** Undocumented event data: tags as names or {name} objects. */
function eventTags(data: Record<string, unknown>): string[] {
  const tags = data.tags;
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t : (t as { name?: unknown })?.name))
    .filter((t): t is string => typeof t === "string");
}

export const gorgias: ConnectorDefinition<GorgiasCredentials> = {
  provider: "gorgias",
  displayName: "Gorgias",
  authKind: "basic",
  credentialsSchema,
  credentialFields: [
    { key: "domain", label: "Domain", secret: false, placeholder: "acme", help: "acme for acme.gorgias.com" },
    { key: "email", label: "User email", secret: false, placeholder: "ops@acme.com" },
    { key: "apiKey", label: "API key", secret: true, help: "Settings → REST API (private app key)" },
  ],
  supportsWebhooks: true,
  supportsSavedReplies: true,
  webhookSetup: {
    secret: "slai",
    steps: [
      "Settings → HTTP integration → Add HTTP integration, URL {url}, POST, application/json.",
      "Triggers: Ticket created, Ticket updated, Ticket message created, Ticket self unsnoozed.",
      'Header X-Slai-Webhook-Secret: {secret}; body {"ticket_id": "{{ticket.id}}"}.',
    ],
  },
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developers.gorgias.com/reference/introduction",
  create(ctx: ConnectorContext<GorgiasCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const domain = creds.domain;
    const base = `https://${domain}.gorgias.com`;
    const http = new HttpClient({
      baseUrl: base,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { Authorization: basicAuth(creds.email, creds.apiKey) },
    });
    const key = (...parts: (string | number)[]) => ["gorgias", domain, ...parts].join(":");
    const time = (v: string | null | undefined, what: string) => parseTime(utc(v), what);

    const snapshot = (t: GTicket): CanonicalTicket => {
      const rawStatus = rawStatusOf(t);
      const m = mappingIssues(ctx.mapping, rawStatus, t.priority ?? null);
      return {
        ref: { sourceId: t.id, displayKey: `#${t.id}`, url: `${base}/app/ticket/${t.id}` },
        subject: t.subject ?? "",
        status: m.status,
        rawStatus,
        priority: m.priority,
        rawPriority: t.priority ?? null,
        requester: {
          sourceId: t.customer?.id ?? null,
          email: t.customer?.email ?? null,
          name: t.customer?.name ?? null,
          orgSourceId: null,
          orgName: null,
        },
        assignee: t.assignee_user ? { sourceId: t.assignee_user.id, name: t.assignee_user.name ?? null } : null,
        groupSourceId: t.assignee_team?.id ?? null,
        tags: (t.tags ?? []).map((x) => x.name),
        channel: t.channel ?? null,
        createdAt: time(t.created_datetime, "ticket.created_datetime"),
        updatedAt: time(t.updated_datetime, "ticket.updated_datetime"),
        mappingIssues: m.issues,
      };
    };

    // collectPages stops on a null token, so the first page's token wraps a null cursor.
    const drainAll = async <T extends z.ZodType>(
      path: string,
      query: Record<string, string | number>,
      item: T,
      what: string,
    ): Promise<z.output<T>[]> =>
      collectPages<z.output<T>, { cursor: string | null }>({ cursor: null }, async ({ cursor }) => {
        const r = parseAs(page(item), await http.get(path, { query: { ...query, cursor } }), what);
        const next = r.meta?.next_cursor;
        return { items: r.data, next: next ? { cursor: next } : null };
      });

    const buildHistory = (t: GTicket, messages: GMessage[], rawEvents: GEvent[]) => {
      const evs = [...rawEvents].sort(
        (a, b) =>
          Date.parse(utc(a.created_datetime) ?? "") - Date.parse(utc(b.created_datetime) ?? "") ||
          Number(a.id) - Number(b.id),
      );
      const snoozes = evs.filter((e) => e.type === "ticket-snoozed");
      const isSnoozeClose = (e: GEvent) =>
        e.type === "ticket-closed" &&
        snoozes.some(
          (s) => (s.context && s.context === e.context) || utc(s.created_datetime) === utc(e.created_datetime),
        );
      const priorityChanges = evs
        .filter((e) => e.type === "ticket-updated")
        .map((e) => eventPriority(e.data ?? {}))
        .filter((p) => p !== null);
      const firstPriority = priorityChanges[0];
      const createdPriority = firstPriority ? (firstPriority.from ?? null) : (t.priority ?? null);

      const createdAt = time(t.created_datetime, "ticket.created_datetime");
      const events: CanonicalEvent[] = [
        {
          type: "created",
          at: createdAt,
          status: mapStatus(ctx.mapping, "open").value,
          priority: mapPriority(ctx.mapping, createdPriority).value,
          idempotencyKey: key("ticket", t.id, "created"),
        },
      ];
      const status = (at: Date, raw: string, k: string): CanonicalEvent => ({
        type: "status_changed",
        at,
        status: mapStatus(ctx.mapping, raw).value,
        rawStatus: raw,
        idempotencyKey: k,
      });
      let tagSet: string[] = [];
      for (const e of evs) {
        const at = time(e.created_datetime, `event ${e.id}`);
        const k = key("event", e.id);
        const data = e.data ?? {};
        switch (e.type) {
          case "ticket-closed":
            if (!isSnoozeClose(e)) events.push(status(at, "closed", k));
            break;
          case "ticket-snoozed":
            events.push(status(at, "snoozed", k));
            break;
          case "ticket-reopened":
          case "ticket-self-unsnoozed":
            events.push(status(at, "open", k));
            break;
          case "ticket-assigned": {
            const a = eventAssignee(data);
            if (a !== undefined) events.push({ type: "assignee_changed", at, assigneeSourceId: a, idempotencyKey: k });
            break;
          }
          case "ticket-unassigned":
            events.push({ type: "assignee_changed", at, assigneeSourceId: null, idempotencyKey: k });
            break;
          case "ticket-updated": {
            const p = eventPriority(data);
            if (p) {
              events.push({
                type: "priority_changed",
                at,
                priority: mapPriority(ctx.mapping, p.to).value,
                rawPriority: p.to,
                idempotencyKey: k,
              });
            }
            break;
          }
          case "ticket-tags-added":
          case "ticket-tags-removed": {
            const names = eventTags(data);
            if (names.length === 0) break;
            tagSet =
              e.type === "ticket-tags-added"
                ? [...new Set([...tagSet, ...names])]
                : tagSet.filter((x) => !names.includes(x));
            events.push({ type: "tags_changed", at, tags: tagSet, idempotencyKey: k });
            break;
          }
          default:
            break;
        }
      }

      const comments: CanonicalComment[] = [];
      const sorted = [...messages].sort(
        (a, b) =>
          Date.parse(utc(a.created_datetime) ?? "") - Date.parse(utc(b.created_datetime) ?? "") ||
          Number(a.id) - Number(b.id),
      );
      sorted.forEach((m, i) => {
        const at = time(m.created_datetime, `message ${m.id}`);
        const role = messageRole(m);
        const pub = m.public !== false && m.channel !== "internal-note";
        events.push({
          type: "comment",
          at,
          author: i === 0 ? openingEventAuthor(role) : role,
          public: pub,
          commentSourceId: m.id,
          idempotencyKey: key("message", m.id),
        });
        comments.push({
          sourceId: m.id,
          at,
          authorRole: role,
          authorName: m.sender?.name ?? null,
          authorSourceId: m.sender?.id ?? null,
          public: pub,
          bodyText: m.body_text ? plainText(m.body_text) : htmlToText(m.body_html),
        });
      });
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    const postMessage = async (sourceId: string, body: Record<string, unknown>) => {
      const r = parseAs(
        z.object({ id }),
        await http.post(`/api/tickets/${encodeURIComponent(sourceId)}/messages`, body),
        "message",
      );
      return { commentSourceId: r.id };
    };

    return {
      async testConnection() {
        const acct = parseAs(
          z.object({ domain: z.string().nullish() }).loose(),
          await http.get("/api/account"),
          "account",
        );
        const d = acct.domain ?? domain;
        return { accountName: `${d}.gorgias.com`, accountId: d };
      },

      async listSavedReplies(cursor) {
        return forbiddenAsUnsupported("Gorgias macros", async () => {
          const isState = (v: unknown): v is { cursor: string } =>
            typeof (v as { cursor?: unknown })?.cursor === "string";
          const state = decodeCursor(cursor, isState);
          const r = parseAs(
            page(zMacro),
            await http.get("/api/macros", { query: { limit: PAGE_LIMIT, cursor: state?.cursor } }),
            "macros",
          );
          const items: KnowledgeArticle[] = [];
          for (const m of r.data) {
            if (m.archived_datetime) continue;
            // Only macros that write a reply; tag-only or assignment macros say nothing to the customer.
            const reply = m.actions?.find((a) => a.name === "setResponseText")?.arguments;
            const bodyText = reply?.body_html
              ? savedReplyText(reply.body_html, "html")
              : savedReplyText(reply?.body_text, "text");
            if (!bodyText) continue;
            items.push({
              sourceId: m.id,
              title: m.name ?? "",
              url: null,
              bodyText,
              locale: m.language ?? null,
              updatedAt: time(m.updated_datetime ?? m.created_datetime, `macro ${m.id}.updated_datetime`),
            });
          }
          const next = r.meta?.next_cursor;
          return { items, nextCursor: next ? encodeCursor({ cursor: next }) : null };
        });
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { cursor: string } =>
          typeof (v as { cursor?: unknown })?.cursor === "string";
        const state = decodeCursor(cursor, isState);
        const r = parseAs(
          page(zTicket),
          await http.get("/api/tickets", {
            query: { order_by: "updated_datetime:desc", limit: PAGE_LIMIT, cursor: state?.cursor },
          }),
          "tickets",
        );
        const sinceMs = since.getTime();
        const fresh = r.data.filter((t) => time(t.updated_datetime, "ticket.updated_datetime").getTime() >= sinceMs);
        // Newest first: the first ticket older than `since` ends the scan.
        const reachedOld = fresh.length < r.data.length;
        const next = r.meta?.next_cursor;
        return {
          items: fresh.map(snapshot),
          nextCursor: next && !reachedOld ? encodeCursor({ cursor: next }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const tid = encodeURIComponent(sourceId);
        const ticket = parseAs(zTicket, await http.get(`/api/tickets/${tid}`), "ticket");
        const messages = await drainAll(
          "/api/messages",
          { ticket_id: sourceId, order_by: "created_datetime:asc", limit: PAGE_LIMIT },
          zMessage,
          "messages",
        );
        const events = await drainAll(
          "/api/events",
          { object_type: "Ticket", object_id: sourceId, order_by: "created_datetime:asc", limit: PAGE_LIMIT },
          zEvent,
          "events",
        );
        const h = buildHistory(ticket, messages, events);
        return { ticket: snapshot(ticket), ...h };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const token = header(req.headers, WEBHOOK_SECRET_HEADER);
        if (!token || !safeEqual(token, secret)) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success || !/^\d+$/.test(parsed.data.ticket_id)) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [parsed.data.ticket_id] };
      },

      async postInternalNote(sourceId, body) {
        return postMessage(sourceId, {
          channel: "internal-note",
          via: "api",
          from_agent: true,
          public: false,
          sender: { email: creds.email },
          body_text: body,
          body_html: textToHtml(body),
        });
      },

      async postPublicReply(sourceId, body) {
        // Reply by email to the address the customer last wrote from, from the
        // support address they wrote to. Other channels (chat, social, SMS) need
        // channel-specific routing we don't model yet.
        const recent = parseAs(
          page(zMessage),
          await http.get("/api/messages", {
            query: { ticket_id: sourceId, order_by: "created_datetime:desc", limit: 30 },
          }),
          "messages",
        ).data;
        const last = recent.find((m) => m.from_agent !== true && m.channel === "email" && m.source?.from?.address);
        const to = last?.source?.from;
        const from = last?.source?.to?.[0];
        if (!last || !to?.address || !from?.address) {
          throw new ConnectorError(`Gorgias ticket ${sourceId} has no inbound email to reply to`, "invalid");
        }
        return postMessage(sourceId, {
          channel: "email",
          via: "api",
          from_agent: true,
          public: true,
          sender: { email: creds.email },
          receiver: { email: to.address },
          source: {
            type: "email",
            from: { address: from.address, name: from.name ?? undefined },
            to: [{ address: to.address, name: to.name ?? undefined }],
          },
          ...(last.subject ? { subject: last.subject.startsWith("Re:") ? last.subject : `Re: ${last.subject}` } : {}),
          body_text: body,
          body_html: textToHtml(body),
        });
      },

      async updateTicket(sourceId, patch) {
        const tid = encodeURIComponent(sourceId);
        const update: Record<string, unknown> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (!raw) throw new ConnectorError(`no Gorgias priority is mapped to "${patch.priority}"`, "invalid");
          update.priority = raw;
        }
        if (patch.assigneeSourceId !== undefined) update.assignee_user = { id: Number(patch.assigneeSourceId) };
        if (Object.keys(update).length > 0) await http.put(`/api/tickets/${tid}`, update);
        if (patch.addTags?.length) await http.post(`/api/tickets/${tid}/tags`, { names: patch.addTags });
      },
    };
  },
};
