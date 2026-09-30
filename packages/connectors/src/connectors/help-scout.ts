/**
 * Help Scout (Inbox / Mailbox API 2.0) connector.
 *
 * API docs (verified 2026-09):
 * - Auth, OAuth2 client credentials (`POST /v2/oauth2/token`, form fields
 *   grant_type/client_id/client_secret; token valid 2 days, 401 when expired):
 *   https://developer.helpscout.com/mailbox-api/overview/authentication/
 * - Rate limits (429 + Retry-After): https://developer.helpscout.com/mailbox-api/overview/rate-limiting/
 * - Resource owner (`GET /v2/users/me`): https://developer.helpscout.com/mailbox-api/endpoints/users/me/
 * - List conversations (status=all, modifiedSince, sortField=modifiedAt, page):
 *   https://developer.helpscout.com/mailbox-api/endpoints/conversations/list/
 * - Get conversation: https://developer.helpscout.com/mailbox-api/endpoints/conversations/get/
 * - List threads: https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/
 * - Thread object (type/status/actionType values): https://developer.helpscout.com/webhooks/objects/thread/
 * - Create note: https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/note/
 * - Create reply (needs `customer.id`): https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/reply/
 * - Update conversation (JSON Patch, `/assignTo`): https://developer.helpscout.com/mailbox-api/endpoints/conversations/update/
 * - Update tags (PUT replaces the whole list): https://developer.helpscout.com/mailbox-api/endpoints/conversations/tags/update/
 * - Webhooks (`X-HelpScout-Signature` = base64 HMAC-SHA1 of the raw body,
 *   `X-HelpScout-Event`, payload = the v2 conversation object):
 *   https://developer.helpscout.com/webhooks/
 *
 * HISTORY — every thread carries the conversation's `status` and `assignedTo`
 * as of that thread, so status and assignee transitions are derived by diffing
 * consecutive threads (lineitems included). Lineitem `action.text` is display
 * copy and is not parsed. A thread without a `status`/`assignedTo` key carries
 * no information (it never produces a change). Drafts and other unpublished
 * threads are ignored.
 *
 * PRIORITY — Help Scout has no native priority. We read it from tags: a tag is
 * a priority tag when it is a key of the mapping's `priority` table, or when it
 * starts with `priority-` (so an unknown `priority-*` tag is flagged as a
 * mapping issue). Threads don't record tag changes, so priority history is
 * unavailable: the created event carries the current priority (same limitation
 * as Freshdesk). Priority write-back swaps the priority tag.
 *
 * BOTS — Help Scout marks thread authors only as `user` or `customer`. A
 * message thread is treated as a bot reply when its `action.type` mentions a
 * workflow (automatic/manual workflow sends) or its `source.type` is
 * `workflow`. Neither value is enumerated for the v2 thread `action.type` in
 * the docs (the example shows "manual-workflow"); confirm on a real account.
 * API-created replies stay "agent" (they are our own approved writes).
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, verifyHmac } from "../lib/hmac.js";
import { DEFAULT_TIMEOUT_MS, HttpClient, parseRetryAfter, type RequestOptions } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText, textToHtml } from "../lib/text.js";
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

const API = "https://api.helpscout.net";
const TOKEN_URL = `${API}/v2/oauth2/token`;
/** Thread ids are global in Help Scout, so the API host is the key namespace. */
const KEY_HOST = "api.helpscout.net";
/** Refresh the cached token this long before Help Scout says it expires. */
const TOKEN_SKEW_MS = 60_000;

const credentialsSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
});
export type HelpScoutCredentials = z.infer<typeof credentialsSchema>;

/**
 * "closed" maps to solved, not closed: a customer reply to a closed Help Scout
 * conversation reopens it (status back to active), which is exactly the
 * canonical solved → open reopen. Spam never needs a reply, so it is closed.
 */
const defaultMapping: FieldMapping = {
  status: { active: "open", pending: "pending", closed: "solved", spam: "closed" },
  priority: {
    "priority-urgent": "urgent",
    "priority-high": "high",
    "priority-normal": "normal",
    "priority-low": "low",
  },
};

const id = z.union([z.number(), z.string()]).transform(String);
const zPerson = z.object({
  id: id.nullish(),
  type: z.string().nullish(),
  first: z.string().nullish(),
  last: z.string().nullish(),
  email: z.string().nullish(),
});
type ZPerson = z.infer<typeof zPerson>;

const zConversation = z.object({
  id,
  number: id.nullish(),
  subject: z.string().nullish(),
  status: z.string(),
  type: z.string().nullish(),
  mailboxId: id.nullish(),
  assignee: zPerson.nullish(),
  primaryCustomer: zPerson.nullish(),
  tags: z.array(z.object({ tag: z.string() }).loose()).nullish(),
  source: z.object({ type: z.string().nullish(), via: z.string().nullish() }).nullish(),
  createdAt: z.string(),
  userUpdatedAt: z.string().nullish(),
  _links: z
    .object({ web: z.object({ href: z.string() }).nullish() })
    .loose()
    .nullish(),
});
type ZConversation = z.infer<typeof zConversation>;

const zThread = z.object({
  id,
  type: z.string(),
  status: z.string().nullish(),
  state: z.string().nullish(),
  action: z.object({ type: z.string().nullish(), text: z.string().nullish() }).loose().nullish(),
  body: z.string().nullish(),
  source: z.object({ type: z.string().nullish(), via: z.string().nullish() }).nullish(),
  createdBy: zPerson.nullish(),
  // Absent = no information; null or id 0 = unassigned.
  assignedTo: zPerson.nullish(),
  createdAt: z.string(),
});
type ZThread = z.infer<typeof zThread>;

const zPage = z.object({ number: z.number(), totalPages: z.number() }).loose();
const zConversations = z.object({
  _embedded: z.object({ conversations: z.array(zConversation) }).nullish(),
  page: zPage,
});
const zThreads = z.object({
  _embedded: z.object({ threads: z.array(zThread) }).nullish(),
  page: zPage.nullish(),
});
const zToken = z.object({ access_token: z.string().min(1), expires_in: z.number().nullish() });
const zWebhook = z.object({ id }).loose();

const personName = (p: ZPerson | null | undefined) =>
  [p?.first, p?.last].filter((s): s is string => !!s?.trim()).join(" ") || null;

/** A person ref's id, or null for "nobody" (Help Scout uses id 0 / null for unassigned). */
const personId = (p: ZPerson | null | undefined) => (p?.id && p.id !== "0" ? p.id : null);

function isBotThread(t: ZThread): boolean {
  if (/workflow/i.test(t.action?.type ?? "")) return true;
  return (t.source?.type ?? "").toLowerCase() === "workflow";
}

/** Role and visibility of a conversation thread; null for non-message threads (lineitems). */
function classify(t: ZThread): { role: AuthorRole; public: boolean } | null {
  const byCustomer = (t.createdBy?.type ?? "").toLowerCase() === "customer";
  switch (t.type) {
    case "customer":
      return { role: "requester", public: true };
    case "message":
      return { role: isBotThread(t) ? "bot" : "agent", public: true };
    case "chat":
    case "beaconchat":
    case "phone":
      return { role: byCustomer ? "requester" : isBotThread(t) ? "bot" : "agent", public: true };
    case "note":
      return { role: isBotThread(t) ? "bot" : "agent", public: false };
    // A forward goes to a third party, not the requester.
    case "forwardparent":
    case "forwardchild":
      return { role: "agent", public: false };
    default:
      return null;
  }
}

export const helpScout: ConnectorDefinition<HelpScoutCredentials> = {
  provider: "help_scout",
  displayName: "Help Scout",
  authKind: "oauth2",
  credentialsSchema,
  credentialFields: [
    { key: "clientId", label: "App ID", secret: false, help: "Your Profile → My Apps → Create My App" },
    { key: "clientSecret", label: "App Secret", secret: true },
  ],
  supportsWebhooks: true,
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://developer.helpscout.com/mailbox-api/",
  create(ctx: ConnectorContext<HelpScoutCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const http = new HttpClient({ baseUrl: API, fetch: ctx.fetch, signal: ctx.signal });
    const key = (...parts: (string | number)[]) => ["help_scout", KEY_HOST, ...parts].join(":");

    // OAuth access token, cached for this client's lifetime only (never persisted).
    let token: { value: string; expiresAt: number } | null = null;

    const fetchToken = async (): Promise<string> => {
      const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await ctx.fetch(TOKEN_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
          }),
          signal,
        });
      } catch (err) {
        throw new ConnectorError(`Help Scout token request failed: ${(err as Error)?.message ?? err}`, "upstream");
      }
      if (res.status === 429 || res.status === 503) {
        throw new ConnectorError(
          `Help Scout token request → ${res.status}`,
          "rate_limited",
          parseRetryAfter(res.headers.get("retry-after")),
        );
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new ConnectorError("Help Scout: invalid App ID or App Secret", "auth");
      }
      if (!res.ok) throw new ConnectorError(`Help Scout token request → ${res.status}`, "upstream");
      const t = parseAs(zToken, tryJson(await res.text()), "oauth2 token");
      token = { value: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 7200) * 1000 - TOKEN_SKEW_MS };
      return t.access_token;
    };

    const accessToken = async () => (token && token.expiresAt > Date.now() ? token.value : fetchToken());

    /**
     * Authenticated request. A 401 on a cached token means it was revoked or
     * expired early: fetch a fresh token once and retry (auth plumbing, not a
     * general retry; the worker still owns retries).
     */
    const call = async <T>(method: "GET" | "POST" | "PUT" | "PATCH", path: string, o: RequestOptions = {}) => {
      const hadToken = token !== null;
      const run = async () =>
        http.request<T>(method, path, {
          ...o,
          headers: { ...o.headers, Authorization: `Bearer ${await accessToken()}` },
        });
      try {
        return await run();
      } catch (err) {
        if (!(hadToken && err instanceof ConnectorError && err.kind === "auth")) throw err;
        token = null;
        return run();
      }
    };
    const get = async (path: string, query?: RequestOptions["query"]) =>
      (await call<unknown>("GET", path, { query })).data;

    const priorityTag = (tags: string[]): string | null => {
      const table = Object.keys(ctx.mapping.priority).map((k) => k.toLowerCase());
      return tags.find((t) => table.includes(t.toLowerCase())) ?? tags.find((t) => /^priority-/i.test(t)) ?? null;
    };
    const isPriorityTag = (t: string) =>
      /^priority-/i.test(t) || Object.keys(ctx.mapping.priority).some((k) => k.toLowerCase() === t.toLowerCase());

    const tagsOf = (c: ZConversation) => (c.tags ?? []).map((t) => t.tag);

    const snapshot = (c: ZConversation): CanonicalTicket => {
      const tags = tagsOf(c);
      const rawPriority = priorityTag(tags);
      const m = mappingIssues(ctx.mapping, c.status, rawPriority);
      const assigneeId = personId(c.assignee);
      return {
        ref: {
          sourceId: c.id,
          displayKey: `#${c.number ?? c.id}`,
          url: c._links?.web?.href ?? `https://secure.helpscout.net/conversation/${c.id}`,
        },
        subject: c.subject ?? "",
        status: m.status,
        rawStatus: c.status,
        priority: m.priority,
        rawPriority,
        requester: {
          sourceId: personId(c.primaryCustomer),
          email: c.primaryCustomer?.email ?? null,
          name: personName(c.primaryCustomer),
          // Customer organizations aren't on the conversation's customer ref.
          orgSourceId: null,
          orgName: null,
        },
        assignee: assigneeId ? { sourceId: assigneeId, name: personName(c.assignee) } : null,
        groupSourceId: c.mailboxId ?? null,
        tags,
        channel: c.source?.type ?? c.type ?? null,
        createdAt: parseTime(c.createdAt, "conversation.createdAt"),
        updatedAt: parseTime(c.userUpdatedAt ?? c.createdAt, "conversation.userUpdatedAt"),
        mappingIssues: m.issues,
      };
    };

    const getConversation = async (sourceId: string) =>
      parseAs(zConversation, await get(`/v2/conversations/${encodeURIComponent(sourceId)}`), "conversation");

    const buildHistory = (c: ZConversation, threads: ZThread[]) => {
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];
      const sorted = threads
        .filter((t) => !t.state || t.state === "published")
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || Number(a.id) - Number(b.id));
      const firstStatus = sorted.find((t) => t.status)?.status ?? c.status;
      events.push({
        type: "created",
        at: parseTime(c.createdAt, "conversation.createdAt"),
        status: mapStatus(ctx.mapping, firstStatus).value,
        // No tag history: the current priority tag stands in (see header).
        priority: mapPriority(ctx.mapping, priorityTag(tagsOf(c))).value,
        idempotencyKey: key("conversation", c.id, "created"),
      });
      let status = firstStatus;
      let assignee: string | null = null;
      let openingSeen = false;
      for (const t of sorted) {
        const at = parseTime(t.createdAt, `thread ${t.id}`);
        const kind = classify(t);
        if (kind) {
          const opening = !openingSeen;
          openingSeen = true;
          events.push({
            type: "comment",
            at,
            author: opening ? openingEventAuthor(kind.role) : kind.role,
            public: kind.public,
            commentSourceId: t.id,
            idempotencyKey: key("thread", t.id),
          });
          comments.push({
            sourceId: t.id,
            at,
            authorRole: kind.role,
            authorName: personName(t.createdBy),
            authorSourceId: personId(t.createdBy),
            public: kind.public,
            bodyText: htmlToText(t.body),
          });
        }
        if (t.status && t.status !== status) {
          status = t.status;
          events.push({
            type: "status_changed",
            at,
            status: mapStatus(ctx.mapping, t.status).value,
            rawStatus: t.status,
            idempotencyKey: key("thread", t.id, "status"),
          });
        }
        if (t.assignedTo !== undefined) {
          const next = personId(t.assignedTo);
          if (next !== assignee) {
            assignee = next;
            events.push({
              type: "assignee_changed",
              at,
              assigneeSourceId: next,
              idempotencyKey: key("thread", t.id, "assignee"),
            });
          }
        }
      }
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    const createThread = async (sourceId: string, kind: "notes" | "reply", body: Record<string, unknown>) => {
      const r = await call<unknown>("POST", `/v2/conversations/${encodeURIComponent(sourceId)}/${kind}`, { body });
      // 201 Created with the new thread's id in the Resource-ID header, no body.
      return { commentSourceId: r.headers.get("resource-id") };
    };

    return {
      async testConnection() {
        const me = parseAs(
          z.object({ id, companyId: id.nullish(), email: z.string().nullish() }).loose(),
          await get("/v2/users/me"),
          "users/me",
        );
        const account = me.companyId ?? me.id;
        return { accountName: `Help Scout company ${account}`, accountId: account };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { page: number } =>
          Number.isInteger((v as { page?: unknown })?.page) && (v as { page: number }).page >= 1;
        const page = decodeCursor(cursor, isState)?.page ?? 1;
        const data = parseAs(
          zConversations,
          await get("/v2/conversations", {
            status: "all",
            // Help Scout wants second precision: 2026-09-28T00:00:00Z.
            modifiedSince: since.toISOString().replace(/\.\d{3}Z$/, "Z"),
            sortField: "modifiedAt",
            sortOrder: "asc",
            page,
          }),
          "conversations",
        );
        return {
          items: (data._embedded?.conversations ?? []).map(snapshot),
          nextCursor: data.page.number < data.page.totalPages ? encodeCursor({ page: data.page.number + 1 }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const conversation = await getConversation(sourceId);
        const threads = await collectPages<ZThread, number>(1, async (page) => {
          const r = parseAs(
            zThreads,
            await get(`/v2/conversations/${encodeURIComponent(sourceId)}/threads`, { page }),
            "threads",
          );
          const more = r.page && r.page.number < r.page.totalPages ? r.page.number + 1 : null;
          return { items: r._embedded?.threads ?? [], next: more };
        });
        const { events, comments } = buildHistory(conversation, threads);
        return { ticket: snapshot(conversation), events, comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const ok = verifyHmac({
          algo: "sha1",
          secret,
          payload: req.rawBody,
          signature: header(req.headers, "x-helpscout-signature"),
          encoding: "base64",
        });
        if (!ok) return { ok: false, reason: "bad_signature" };
        const body = tryJson(req.rawBody);
        if (body === undefined) return { ok: false, reason: "malformed" };
        const event = header(req.headers, "x-helpscout-event");
        // customer.*, satisfaction.*, tag.* … carry no conversation.
        if (event && !event.startsWith("convo.")) return { ok: true, ticketSourceIds: [] };
        const parsed = zWebhook.safeParse(body);
        if (!parsed.success || !/^\d+$/.test(parsed.data.id)) return { ok: false, reason: "malformed" };
        return { ok: true, ticketSourceIds: [parsed.data.id] };
      },

      async postInternalNote(sourceId, body) {
        return createThread(sourceId, "notes", { text: textToHtml(body) });
      },

      async postPublicReply(sourceId, body) {
        const c = await getConversation(sourceId);
        const customerId = personId(c.primaryCustomer);
        if (!customerId) throw new ConnectorError(`Help Scout conversation ${sourceId} has no customer`, "invalid");
        // No `status`: the conversation keeps Help Scout's default after-reply behaviour.
        return createThread(sourceId, "reply", { customer: { id: Number(customerId) }, text: textToHtml(body) });
      },

      async updateTicket(sourceId, patch) {
        const cid = encodeURIComponent(sourceId);
        let rawPriority: string | null = null;
        if (patch.priority) {
          rawPriority = rawPriorityFor(ctx.mapping, patch.priority);
          if (!rawPriority) throw new ConnectorError(`no Help Scout tag is mapped to "${patch.priority}"`, "invalid");
        }
        if (patch.assigneeSourceId !== undefined) {
          await call("PATCH", `/v2/conversations/${cid}`, {
            body: { op: "replace", path: "/assignTo", value: Number(patch.assigneeSourceId) },
          });
        }
        if (rawPriority || patch.addTags?.length) {
          // PUT replaces the whole tag list, so read the current tags and merge.
          const current = tagsOf(await getConversation(sourceId));
          const kept = rawPriority ? current.filter((t) => !isPriorityTag(t)) : current;
          const next = [...new Set([...kept, ...(rawPriority ? [rawPriority] : []), ...(patch.addTags ?? [])])];
          await call("PUT", `/v2/conversations/${cid}/tags`, { body: { tags: next } });
        }
      },
    };
  },
};
