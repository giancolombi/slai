/**
 * Zoho Desk connector.
 *
 * API docs (verified 2026-09):
 * - API reference (tickets, threads, comments, history, tags, sendReply, orgId header): https://desk.zoho.com/DeskAPIDocument
 * - Ticket history events and eventInfo shapes: https://help.zoho.com/portal/en/kb/desk/developer-space/rest-apis/articles/events-supported-in-get-ticket-history-api
 * - OAuth refresh-token flow: https://www.zoho.com/accounts/protocol/oauth/web-apps/access-token-expiry.html
 * - Multi data centre domains (accounts/api per DC): https://www.zoho.com/crm/developer/docs/api/v8/multi-dc.html
 * - Webhooks (payload is an array of events, X-ZDesk-JWT RS256 authentication, plan limits):
 *   https://desk.zoho.com/support/WebhookDocument.do
 *
 * AUTH — OAuth 2.0 self-client / server-based client. We exchange the stored
 * refresh token at `POST https://accounts.zoho.<dc>/oauth/v2/token` (params in
 * the query string, as Zoho documents) and cache the access token in the
 * create() closure until shortly before `expires_in`. API calls go to
 * `https://desk.zoho.<dc>/api/v1` with `Authorization: Zoho-oauthtoken <token>`
 * and the `orgId` header. Zoho answers a bad refresh token with HTTP 200 and
 * `{"error":"invalid_code"}`, so the body is checked too. Canada uses the
 * zohocloud.ca domains.
 *
 * LIST — `GET /tickets` has no "modified since" filter. We sort by
 * `-modifiedTime` (newest first) and page with `from`/`limit`, stopping at the
 * first ticket modified before `since`. Newest-first is deliberate: a ticket
 * modified mid-scan jumps to the front and shifts the rest back, which can only
 * produce duplicates (harmless: the worker dedupes), never skips; ascending
 * offset paging would skip a ticket whenever an earlier one moved to the end.
 * An empty page may come back as 204 No Content. Zoho may cap the `from`
 * offset on very deep scans; that cap is not documented (needs a real account).
 *
 * HISTORY — `GET /tickets/{id}/History` gives status, priority and owner
 * transitions (TicketUpdated, eventInfo ValueTransition). Events carry no id,
 * so their idempotency key is derived from eventTime + eventName + property.
 * Replies come from `/threads` (direction in/out, visibility public/private,
 * author.type) and notes from `/comments` (isPublic). The thread list returns
 * a `summary`, not the full body; we keep `content` when present, else the
 * summary (fetching every thread's body would cost one call each).
 * Bots: the docs list author types END_USER and AGENT; any other author type on
 * a thread or comment (e.g. SYSTEM from workflow auto-acknowledgements) is
 * treated as a bot. That exact value is not documented and needs a real
 * account to confirm. Tag history events (TagsAdded/TagsRemoved) have no
 * documented eventInfo shape, so we read only the current tags.
 *
 * WEBHOOKS — Zoho Desk webhooks are unavailable on the Free and Standard
 * editions (poll only there). Deliveries carry `X-ZDesk-JWT`, an RS256 JWT
 * signed by Zoho (key id in `kid`, public keys at `/.well-known/jwks.json` on
 * the Desk domain) with claims iss = org id, aud = webhook id, exp/iat in epoch
 * milliseconds. There is no shared secret, so the connection's webhook secret
 * holds the Zoho webhook id we expect as `aud`; iss must equal the connected
 * org. The JWT does not cover the body, so a captured token could be replayed
 * with another body until it expires; a delivery only makes us re-fetch the
 * named tickets over the API, so that is limited to extra polling. JWKS on the
 * non-.com data centres is assumed at the same path (only .com is shown).
 */
import { createPublicKey, verify as rsaVerify } from "node:crypto";
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, safeEqual } from "../lib/hmac.js";
import { HttpClient, type Method, type RequestOptions } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText, plainText, textToHtml } from "../lib/text.js";
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

export const ZOHO_DATA_CENTERS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn"] as const;
type DataCenter = (typeof ZOHO_DATA_CENTERS)[number];

/** Accounts and Desk hosts per data centre (Canada runs on zohocloud.ca). */
function hosts(dc: DataCenter): { accounts: string; desk: string } {
  if (dc === "ca") return { accounts: "https://accounts.zohocloud.ca", desk: "https://desk.zohocloud.ca" };
  return { accounts: `https://accounts.zoho.${dc}`, desk: `https://desk.zoho.${dc}` };
}

const credentialsSchema = z.object({
  dataCenter: z.enum(ZOHO_DATA_CENTERS),
  orgId: z.string().trim().regex(/^\d+$/, "The numeric organization id (Setup → Developer Space → API)"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});
export type ZohoDeskCredentials = z.infer<typeof credentialsSchema>;

const configSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100).default(100),
    /** Support address public replies are sent from; defaults to the ticket's last outgoing thread. */
    fromEmailAddress: z.email().optional(),
  })
  .loose();

const defaultMapping: FieldMapping = {
  status: {
    Open: "open",
    Escalated: "open",
    "Waiting on Customer": "pending",
    "On Hold": "on_hold",
    Closed: "closed",
  },
  // Zoho's default layout has High/Medium/Low; add custom values (e.g. Urgent) per connection.
  priority: { High: "high", Medium: "normal", Low: "low" },
};

const TOKEN_SKEW_MS = 60_000;
const HISTORY_PAGE = 50;
const THREAD_PAGE = 100;

const id = z.union([z.number(), z.string()]).transform(String);
const zPerson = z
  .object({
    id: id.nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    type: z.string().nullish(),
  })
  .loose();
const zTicket = z.object({
  id,
  ticketNumber: z.union([z.string(), z.number()]).transform(String).nullish(),
  subject: z.string().nullish(),
  status: z.string().nullish(),
  statusType: z.string().nullish(),
  priority: z.string().nullish(),
  channel: z.string().nullish(),
  email: z.string().nullish(),
  contactId: id.nullish(),
  assigneeId: id.nullish(),
  departmentId: id.nullish(),
  webUrl: z.string().nullish(),
  createdTime: z.string(),
  modifiedTime: z.string(),
  contact: zPerson
    .extend({ account: z.object({ id: id.nullish(), accountName: z.string().nullish() }).loose().nullish() })
    .nullish(),
  assignee: zPerson.nullish(),
});
type ZTicket = z.infer<typeof zTicket>;

const zList = <T extends z.ZodType>(item: T) =>
  z
    .object({ data: z.array(item) })
    .nullable()
    .transform((r) => r?.data ?? []);

const zValue = z.union([z.string(), z.number(), z.boolean(), zPerson, z.null()]);
const zHistoryEvent = z.object({
  eventName: z.string(),
  eventTime: z.string(),
  actor: zPerson.nullish(),
  eventInfo: z
    .array(
      z
        .object({
          propertyName: z.string(),
          propertyType: z.string().nullish(),
          propertyValue: z
            .union([z.object({ previousValue: zValue.optional(), updatedValue: zValue.optional() }).loose(), zValue])
            .nullish(),
        })
        .loose(),
    )
    .nullish(),
});

const zThread = z.object({
  id,
  channel: z.string().nullish(),
  direction: z.string().nullish(),
  visibility: z.string().nullish(),
  author: zPerson.nullish(),
  createdTime: z.string(),
  summary: z.string().nullish(),
  content: z.string().nullish(),
  contentType: z.string().nullish(),
  fromEmailAddress: z.string().nullish(),
});
type ZThread = z.infer<typeof zThread>;

const zComment = z.object({
  id,
  content: z.string().nullish(),
  contentType: z.string().nullish(),
  isPublic: z.boolean().nullish(),
  commenterId: id.nullish(),
  commenter: zPerson.nullish(),
  commentedTime: z.string(),
});

const zToken = z.object({
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
});

const zWebhook = z
  .array(
    z
      .object({
        eventType: z.string(),
        orgId: id.nullish(),
        payload: z.object({ id: id.nullish(), ticketId: id.nullish() }).loose().nullish(),
      })
      .loose(),
  )
  .min(1);

const zJwks = z.object({
  keys: z.array(z.object({ kid: z.string(), kty: z.string() }).loose()),
});

/** Zoho author types: END_USER (contact), AGENT; anything else is automation. */
function authorRole(type: string | null | undefined, direction?: string | null): AuthorRole {
  const t = (type ?? "").toUpperCase();
  if (t === "END_USER" || t === "CONTACT") return "requester";
  if (t === "AGENT") return "agent";
  if (t === "") return direction === "in" ? "requester" : "agent";
  return "bot";
}

function personName(p: z.infer<typeof zPerson> | null | undefined): string | null {
  if (!p) return null;
  if (p.name) return p.name;
  const n = [p.firstName, p.lastName].filter(Boolean).join(" ");
  return n || null;
}

/** The JWK form of createPublicKey's input. */
type JwkInput = Extract<Parameters<typeof createPublicKey>[0], { format: "jwk" }>;

function b64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Zoho documents exp/iat in epoch ms; accept seconds too. */
function epochMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v < 1e12 ? v * 1000 : v;
}

export const zohoDesk: ConnectorDefinition<ZohoDeskCredentials> = {
  provider: "zoho_desk",
  displayName: "Zoho Desk",
  authKind: "oauth2",
  credentialsSchema,
  credentialFields: [
    {
      key: "dataCenter",
      label: "Data centre",
      secret: false,
      placeholder: "com",
      help: "The domain your Zoho account lives on: com, eu, in, com.au, jp, ca, sa or com.cn",
    },
    { key: "orgId", label: "Organization ID", secret: false, help: "Setup → Developer Space → API" },
    { key: "clientId", label: "Client ID", secret: false, help: "api-console.zoho.com → your client" },
    { key: "clientSecret", label: "Client secret", secret: true },
    {
      key: "refreshToken",
      label: "Refresh token",
      secret: true,
      help: "Scopes: Desk.tickets.ALL, Desk.basic.READ, Desk.settings.READ",
    },
  ],
  supportsWebhooks: true,
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://desk.zoho.com/DeskAPIDocument",
  create(ctx: ConnectorContext<ZohoDeskCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const cfg = configSchema.parse(ctx.config ?? {});
    const { accounts, desk } = hosts(creds.dataCenter);
    const deskHost = new URL(desk).host;
    const accountsHttp = new HttpClient({ baseUrl: accounts, fetch: ctx.fetch, signal: ctx.signal });
    const deskHttp = new HttpClient({ baseUrl: desk, fetch: ctx.fetch, signal: ctx.signal });
    const http = new HttpClient({
      baseUrl: `${desk}/api/v1`,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: { orgId: creds.orgId },
    });
    const key = (...parts: (string | number)[]) => ["zoho_desk", creds.orgId, ...parts].join(":");

    let token: { value: string; expiresAt: number } | null = null;
    const accessToken = async (): Promise<string> => {
      if (token && token.expiresAt > Date.now()) return token.value;
      const r = parseAs(
        zToken,
        await accountsHttp.post("/oauth/v2/token", undefined, {
          query: {
            refresh_token: creds.refreshToken,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            grant_type: "refresh_token",
          },
        }),
        "oauth token",
      );
      if (r.error || !r.access_token) throw new ConnectorError(`Zoho OAuth: ${r.error ?? "no access token"}`, "auth");
      token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS };
      return token.value;
    };

    const api = async <T = unknown>(method: Method, path: string, o: RequestOptions = {}): Promise<T> => {
      const t = await accessToken();
      try {
        const res = await http.request<T>(method, path, {
          ...o,
          headers: { ...o.headers, Authorization: `Zoho-oauthtoken ${t}` },
        });
        return res.data;
      } catch (err) {
        // A revoked or expired token: drop it so the worker's retry refreshes.
        if (err instanceof ConnectorError && err.kind === "auth") token = null;
        throw err;
      }
    };
    const get = <T = unknown>(path: string, query?: RequestOptions["query"]) => api<T>("GET", path, { query });

    const statusOf = (raw: string, statusType: string | null | undefined) => {
      const m = mapStatus(ctx.mapping, raw);
      if (m.known || !statusType) return m.value;
      // Custom statuses fall back to Zoho's own status type (Open/On Hold/Closed); still flagged as unmapped.
      const byType = mapStatus(ctx.mapping, statusType);
      return byType.known ? byType.value : m.value;
    };

    const snapshot = (t: ZTicket, tags: string[]): CanonicalTicket => {
      const rawStatus = t.status ?? t.statusType ?? "Open";
      const m = mappingIssues(ctx.mapping, rawStatus, t.priority ?? null);
      return {
        ref: {
          sourceId: t.id,
          displayKey: t.ticketNumber ? `#${t.ticketNumber}` : `#${t.id}`,
          url: t.webUrl ?? null,
        },
        subject: t.subject ?? "",
        status: statusOf(rawStatus, t.statusType),
        rawStatus,
        priority: m.priority,
        rawPriority: t.priority ?? null,
        requester: {
          sourceId: t.contactId ?? t.contact?.id ?? null,
          email: t.email ?? t.contact?.email ?? null,
          name: personName(t.contact),
          orgSourceId: t.contact?.account?.id ?? null,
          orgName: t.contact?.account?.accountName ?? null,
        },
        assignee: t.assigneeId ? { sourceId: t.assigneeId, name: personName(t.assignee) } : null,
        groupSourceId: t.departmentId ?? null,
        tags,
        channel: t.channel ?? null,
        createdAt: parseTime(t.createdTime, "ticket.createdTime"),
        updatedAt: parseTime(t.modifiedTime, "ticket.modifiedTime"),
        mappingIssues: m.issues,
      };
    };

    /** Drains a from/limit sub-resource; a short page (or 204) ends it. */
    const drain = <S extends z.ZodType>(path: string, item: S, limit: number, what: string) =>
      collectPages<z.output<S>, number>(0, async (from) => {
        const items = parseAs(zList(item), await get(path, { from, limit }), what);
        return { items, next: items.length >= limit ? from + limit : null };
      });

    const getTicket = async (tid: string) =>
      parseAs(zTicket, await get(`/tickets/${tid}`, { include: "contacts,assignee" }), "ticket");

    const listThreads = (tid: string) => drain(`/tickets/${tid}/threads`, zThread, THREAD_PAGE, "threads");

    let jwks: Map<string, z.infer<typeof zJwks>["keys"][number]> | null = null;
    let jwksFetchedAt = 0;
    // An unknown `kid` triggers at most one refetch per minute, so forged
    // deliveries can't turn every webhook into an outbound JWKS request.
    const jwk = async (kid: string, refresh: boolean) => {
      if (!jwks || (refresh && Date.now() - jwksFetchedAt > 60_000)) {
        jwksFetchedAt = Date.now();
        const set = parseAs(zJwks, await deskHttp.get("/.well-known/jwks.json"), "jwks");
        jwks = new Map(set.keys.map((k) => [k.kid, k]));
      }
      return jwks.get(kid) ?? null;
    };

    /** Verifies X-ZDesk-JWT (RS256 over Zoho's JWKS); true when iss/aud/exp all check out. */
    const verifyJwt = async (jwt: string, expectedAud: string): Promise<boolean> => {
      const parts = jwt.trim().split(".");
      if (parts.length !== 3) return false;
      const [h, p, s] = parts as [string, string, string];
      let head: { alg?: unknown; kid?: unknown };
      let claims: { iss?: unknown; aud?: unknown; exp?: unknown };
      try {
        head = JSON.parse(b64url(h).toString("utf8"));
        claims = JSON.parse(b64url(p).toString("utf8"));
      } catch {
        return false;
      }
      if (head.alg !== "RS256" || typeof head.kid !== "string") return false;
      const k = (await jwk(head.kid, false)) ?? (await jwk(head.kid, true));
      if (!k) return false;
      let ok = false;
      try {
        const pub = createPublicKey({ key: k as JwkInput["key"], format: "jwk" });
        ok = rsaVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), pub, b64url(s));
      } catch {
        return false;
      }
      if (!ok) return false;
      if (typeof claims.iss !== "string" && typeof claims.iss !== "number") return false;
      if (!safeEqual(String(claims.iss), creds.orgId)) return false;
      const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
      if (!aud.some((a) => safeEqual(a, expectedAud))) return false;
      const exp = epochMs(claims.exp);
      return exp !== null && exp > Date.now();
    };

    return {
      async testConnection() {
        const org = parseAs(
          z.object({ id, companyName: z.string().nullish(), portalName: z.string().nullish() }).loose(),
          await get(`/organizations/${creds.orgId}`),
          "organization",
        );
        return { accountName: org.companyName ?? org.portalName ?? deskHost, accountId: org.id };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { from: number } => typeof (v as { from?: unknown })?.from === "number";
        const from = decodeCursor(cursor, isState)?.from ?? 0;
        const tickets = parseAs(
          zList(zTicket),
          await get("/tickets", {
            from,
            limit: cfg.pageSize,
            sortBy: "-modifiedTime",
            include: "contacts,assignee",
          }),
          "tickets",
        );
        const fresh = tickets.filter((t) => Date.parse(t.modifiedTime) >= since.getTime());
        // Newest first: once a ticket predates `since`, everything after it does too.
        const exhausted = fresh.length < tickets.length || tickets.length < cfg.pageSize;
        return {
          // Tags aren't in the list response; getTicketWithHistory reads them.
          items: fresh.map((t) => snapshot(t, [])),
          nextCursor: exhausted ? null : encodeCursor({ from: from + cfg.pageSize }),
        };
      },

      async getTicketWithHistory(sourceId) {
        const tid = encodeURIComponent(sourceId);
        const ticket = await getTicket(tid);
        const history = await drain(`/tickets/${tid}/History`, zHistoryEvent, HISTORY_PAGE, "ticket history");
        const threads = await listThreads(tid);
        const notes = await drain(`/tickets/${tid}/comments`, zComment, THREAD_PAGE, "comments");
        const tags = parseAs(
          zList(z.object({ name: z.string() }).loose()),
          await get(`/tickets/${tid}/tags`),
          "tags",
        ).map((t) => t.name);

        type Change = { at: string; name: string; prop: string; prev: unknown; next: unknown };
        const changes: Change[] = [];
        for (const e of history) {
          if (e.eventName !== "TicketUpdated") continue;
          for (const info of e.eventInfo ?? []) {
            const v = info.propertyValue;
            if (info.propertyType !== "ValueTransition" || !v || typeof v !== "object" || !("updatedValue" in v)) {
              continue;
            }
            changes.push({
              at: e.eventTime,
              name: e.eventName,
              prop: info.propertyName,
              prev: v.previousValue ?? null,
              next: v.updatedValue ?? null,
            });
          }
        }
        changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
        const isOwner = (p: string) => /^(case|ticket) owner$|^owner$|^assignee$/i.test(p);
        const firstPrev = (prop: string) => {
          const c = changes.find((x) => x.prop === prop);
          return c ? str(c.prev) : undefined;
        };

        const createdAt = parseTime(
          history.find((e) => e.eventName === "TicketCreated")?.eventTime ?? ticket.createdTime,
          "ticket created",
        );
        const createdStatus = firstPrev("Status") ?? ticket.status ?? "Open";
        const createdPriority = firstPrev("Priority");
        const events: CanonicalEvent[] = [
          {
            type: "created",
            at: createdAt,
            status: statusOf(createdStatus, createdStatus === ticket.status ? ticket.statusType : null),
            priority: mapPriority(
              ctx.mapping,
              createdPriority === undefined ? (ticket.priority ?? null) : createdPriority,
            ).value,
            idempotencyKey: key("ticket", ticket.id, "created"),
          },
        ];
        for (const c of changes) {
          const at = parseTime(c.at, `history ${c.name}`);
          const k = key("history", ticket.id, at.toISOString(), c.name, c.prop);
          if (c.prop === "Status") {
            const raw = str(c.next);
            if (!raw) continue;
            events.push({
              type: "status_changed",
              at,
              status: statusOf(raw, raw === ticket.status ? ticket.statusType : null),
              rawStatus: raw,
              idempotencyKey: k,
            });
          } else if (c.prop === "Priority") {
            const raw = str(c.next);
            events.push({
              type: "priority_changed",
              at,
              priority: mapPriority(ctx.mapping, raw).value,
              rawPriority: raw,
              idempotencyKey: k,
            });
          } else if (isOwner(c.prop)) {
            const next = c.next as { id?: string | number } | null;
            const assignee = next && typeof next === "object" && next.id ? String(next.id) : null;
            events.push({ type: "assignee_changed", at, assigneeSourceId: assignee, idempotencyKey: k });
          }
        }

        type Msg = CanonicalComment & { key: string; order: number };
        const msgs: Msg[] = [
          ...threads.map((t: ZThread, i) => ({
            sourceId: t.id,
            at: parseTime(t.createdTime, `thread ${t.id}`),
            authorRole: authorRole(t.author?.type, t.direction),
            authorName: personName(t.author),
            authorSourceId: t.author?.id ?? null,
            public: (t.visibility ?? "public").toLowerCase() !== "private",
            bodyText: t.content
              ? (t.contentType ?? "html").toLowerCase().includes("html")
                ? htmlToText(t.content)
                : plainText(t.content)
              : plainText(t.summary),
            key: key("thread", t.id),
            order: i,
          })),
          ...notes.map((n, i) => ({
            sourceId: n.id,
            at: parseTime(n.commentedTime, `comment ${n.id}`),
            authorRole: authorRole(n.commenter?.type ?? "AGENT"),
            authorName: personName(n.commenter),
            authorSourceId: n.commenterId ?? n.commenter?.id ?? null,
            public: n.isPublic === true,
            bodyText: (n.contentType ?? "html").toLowerCase().includes("html")
              ? htmlToText(n.content)
              : plainText(n.content),
            key: key("comment", n.id),
            order: threads.length + i,
          })),
        ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order);

        const comments: CanonicalComment[] = [];
        msgs.forEach(({ key: k, order: _order, ...c }, i) => {
          events.push({
            type: "comment",
            at: c.at,
            author: i === 0 ? openingEventAuthor(c.authorRole) : c.authorRole,
            public: c.public,
            commentSourceId: c.sourceId,
            idempotencyKey: k,
          });
          comments.push(c);
        });

        return { ticket: snapshot(ticket, tags), events: dropNoopChanges(finalizeEvents(events)), comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const jwt = header(req.headers, "x-zdesk-jwt");
        if (!jwt || !(await verifyJwt(jwt, secret))) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const ids = new Set<string>();
        for (const e of parsed.data) {
          if (!e.eventType.startsWith("Ticket")) continue;
          const tid = e.payload?.ticketId ?? e.payload?.id;
          if (tid) ids.add(tid);
        }
        return { ok: true, ticketSourceIds: [...ids] };
      },

      async postInternalNote(sourceId, body) {
        const r = parseAs(
          z.object({ id }).loose(),
          await api("POST", `/tickets/${encodeURIComponent(sourceId)}/comments`, {
            body: { isPublic: false, contentType: "html", content: textToHtml(body) },
          }),
          "comment",
        );
        return { commentSourceId: r.id };
      },

      async postPublicReply(sourceId, body) {
        const tid = encodeURIComponent(sourceId);
        const t = await getTicket(tid);
        const to = t.email ?? t.contact?.email;
        if (!to) throw new ConnectorError(`Zoho Desk ticket ${sourceId} has no contact email`, "invalid");
        let from = cfg.fromEmailAddress ?? null;
        if (!from) {
          const outgoing = (await listThreads(tid))
            .filter((x) => x.direction === "out" && x.fromEmailAddress)
            .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime));
          // Thread addresses come as `"Name"<addr>`; sendReply wants the bare address.
          const raw = outgoing[0]?.fromEmailAddress ?? null;
          from = raw ? (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim() : null;
        }
        if (!from) {
          throw new ConnectorError(
            `Zoho Desk ticket ${sourceId}: no support address to reply from (set config.fromEmailAddress)`,
            "invalid",
          );
        }
        const r = parseAs(
          z.object({ id }).loose(),
          await api("POST", `/tickets/${tid}/sendReply`, {
            body: { channel: "EMAIL", to, fromEmailAddress: from, contentType: "html", content: textToHtml(body) },
          }),
          "sendReply",
        );
        return { commentSourceId: r.id };
      },

      async updateTicket(sourceId, patch) {
        const tid = encodeURIComponent(sourceId);
        const update: Record<string, unknown> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (!raw) throw new ConnectorError(`no Zoho Desk priority is mapped to "${patch.priority}"`, "invalid");
          update.priority = raw;
        }
        if (patch.assigneeSourceId !== undefined) update.assigneeId = patch.assigneeSourceId;
        if (Object.keys(update).length > 0) await api("PATCH", `/tickets/${tid}`, { body: update });
        if (patch.addTags?.length) await api("POST", `/tickets/${tid}/associateTag`, { body: { tags: patch.addTags } });
      },
    };
  },
};
