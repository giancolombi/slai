/**
 * HubSpot Service Hub connector (tickets).
 *
 * API docs (verified 2026-09):
 * - Tickets (search, propertiesWithHistory): https://developers.hubspot.com/docs/api-reference/crm-tickets-v3/guide
 * - Email engagements: https://developers.hubspot.com/docs/api-reference/crm-emails-v3/guide
 * - Note engagements: https://developers.hubspot.com/docs/api-reference/crm-notes-v3/guide
 * - Association type ids (note→ticket 228): https://developers.hubspot.com/docs/api-reference/crm-associations-v4/guide
 * - Webhook signature v3: https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests
 * - Webhook payloads: https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide
 * - Account details: https://developers.hubspot.com/docs/api-reference/account-account-info-v3/guide
 *
 * Status is the pipeline stage id (`hs_pipeline_stage`). The default mapping
 * covers the default Support pipeline; custom pipelines need a per-connection
 * mapping (unknown stages are flagged and default to open).
 *
 * History: stage/priority/owner transitions come from `propertiesWithHistory`;
 * messages come from the ticket's associated emails (direction gives requester
 * vs agent) and notes (internal). The ticket's `content` property is the
 * opening message. Conversations-inbox threads are not read, and there is no
 * bot detection: HubSpot emails carry no bot marker.
 *
 * Webhooks: HubSpot v3 signatures. HubSpot webhooks are always POST, so the
 * signed method is "POST" (WebhookRequest carries no method).
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, hmac, safeEqual } from "../lib/hmac.js";
import { HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { oauthFetch, oauthTokenFields, readTokens } from "../lib/oauth.js";
import { decodeCursor, encodeCursor } from "../lib/paginate.js";
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

/** A private-app token, or an OAuth access token (with its refresh token) from the connect flow. */
const credentialsSchema = z.object({ accessToken: z.string().min(1), ...oauthTokenFields });
export type HubspotCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  // Default Support pipeline stage ids.
  status: { "1": "new", "2": "pending", "3": "open", "4": "closed" },
  priority: { LOW: "low", MEDIUM: "normal", HIGH: "high", URGENT: "urgent" },
};

export const TICKET_PROPERTIES = [
  "subject",
  "content",
  "hs_pipeline",
  "hs_pipeline_stage",
  "hs_ticket_priority",
  "hubspot_owner_id",
  "createdate",
  "hs_lastmodifieddate",
  "source_type",
];
const HISTORY_PROPERTIES = ["hs_pipeline_stage", "hs_ticket_priority", "hubspot_owner_id"] as const;

/** Search is capped at 10,000 results per query; re-anchor `since` before hitting it. */
const SEARCH_REANCHOR_AT = 9900;
const WEBHOOK_MAX_AGE_MS = 5 * 60_000;
const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const NOTE_TO_TICKET = 228;

const id = z.union([z.string(), z.number()]).transform(String);
const zProps = z.record(z.string(), z.string().nullish());
const zObject = z.object({ id, properties: zProps, createdAt: z.string().nullish(), updatedAt: z.string().nullish() });
type ZObject = z.infer<typeof zObject>;
const zSearch = z.object({
  results: z.array(zObject),
  paging: z.object({ next: z.object({ after: z.string() }).nullish() }).nullish(),
});
const zHistoryEntry = z.object({ value: z.string().nullish(), timestamp: z.string() });
const zAssoc = z.object({ results: z.array(z.object({ id })) }).nullish();
const zTicket = zObject.extend({
  propertiesWithHistory: z.record(z.string(), z.array(zHistoryEntry)).nullish(),
  associations: z.object({ emails: zAssoc, notes: zAssoc, contacts: zAssoc, companies: zAssoc }).loose().nullish(),
});
type ZTicket = z.infer<typeof zTicket>;
const zBatch = z.object({ results: z.array(zObject) });

const zWebhookEvent = z
  .object({
    objectId: id,
    subscriptionType: z.string().nullish(),
    eventType: z.string().nullish(),
    objectTypeId: z.string().nullish(),
  })
  .loose();
const zWebhook = z.array(zWebhookEvent);

/** HubSpot v3: decode only these escapes in the URI before signing. */
const URI_DECODES: Record<string, string> = {
  "%3A": ":",
  "%2F": "/",
  "%3F": "?",
  "%40": "@",
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%3B": ";",
};
export function decodeHubspotUri(uri: string): string {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => URI_DECODES[m.toUpperCase()] ?? m);
}

export const hubspot: ConnectorDefinition<HubspotCredentials> = {
  provider: "hubspot",
  displayName: "HubSpot Service Hub",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    {
      key: "accessToken",
      label: "Private app access token",
      secret: true,
      help: "Settings → Integrations → Private apps. Scopes: tickets, crm.objects.contacts.read, crm.objects.companies.read, sales-email-read.",
    },
  ],
  supportsWebhooks: true,
  webhookSetup: {
    secret: "provider",
    steps: [
      "In your HubSpot developer account, open the app → Webhooks and set the target URL to {url}.",
      "Subscribe to ticket.creation, ticket.propertyChange (hs_pipeline_stage, hs_ticket_priority, hubspot_owner_id) and ticket.associationChange.",
      "Copy the app's client secret (Auth tab) and paste it below: HubSpot signs webhooks with it (signature v3).",
    ],
  },
  oauth: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: TOKEN_URL,
    scopes: ["oauth", "tickets", "crm.objects.contacts.read", "crm.objects.companies.read", "sales-email-read"],
    pkce: false,
    toCredentials: ({ token, clientId, clientSecret, now }) => ({ ...readTokens(token, now), clientId, clientSecret }),
  },
  write: { internalNote: true, publicReply: false, assign: true, priority: true, tags: false },
  defaultMapping,
  docsUrl: "https://developers.hubspot.com/docs/api-reference/crm-tickets-v3/guide",
  create(ctx: ConnectorContext<HubspotCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const http = new HttpClient({
      baseUrl: "https://api.hubapi.com",
      fetch: oauthFetch(ctx, creds, TOKEN_URL),
      signal: ctx.signal,
    });
    const portalId =
      typeof ctx.config?.portalId === "string" || typeof ctx.config?.portalId === "number"
        ? String(ctx.config.portalId)
        : null;

    const snapshot = (t: ZObject, people: { contact?: ZObject; company?: ZObject } = {}): CanonicalTicket => {
      const p = t.properties;
      const rawStatus = p.hs_pipeline_stage ?? "";
      const rawPriority = p.hs_ticket_priority || null;
      const m = mappingIssues(ctx.mapping, rawStatus, rawPriority);
      const c = people.contact?.properties;
      const name = c ? [c.firstname, c.lastname].filter(Boolean).join(" ") || null : null;
      const owner = p.hubspot_owner_id || null;
      return {
        ref: {
          sourceId: t.id,
          displayKey: `#${t.id}`,
          url: portalId ? `https://app.hubspot.com/contacts/${portalId}/ticket/${t.id}` : null,
        },
        subject: p.subject ?? "",
        status: m.status,
        rawStatus,
        priority: m.priority,
        rawPriority,
        requester: {
          sourceId: people.contact?.id ?? null,
          email: c?.email ?? null,
          name,
          orgSourceId: people.company?.id ?? null,
          orgName: people.company?.properties.name ?? null,
        },
        assignee: owner ? { sourceId: owner, name: null } : null,
        groupSourceId: null,
        tags: [],
        channel: p.source_type ? p.source_type.toLowerCase() : null,
        createdAt: parseTime(p.createdate ?? t.createdAt, "ticket.createdate"),
        updatedAt: parseTime(p.hs_lastmodifieddate ?? t.updatedAt, "ticket.hs_lastmodifieddate"),
        mappingIssues: m.issues,
      };
    };

    const batchRead = async (object: string, ids: string[], properties: string[]): Promise<ZObject[]> => {
      if (ids.length === 0) return [];
      const out: ZObject[] = [];
      // Batch read accepts up to 100 inputs per call.
      for (let i = 0; i < ids.length; i += 100) {
        const r = parseAs(
          zBatch,
          await http.post(`/crm/v3/objects/${object}/batch/read`, {
            properties,
            inputs: ids.slice(i, i + 100).map((x) => ({ id: x })),
          }),
          `${object} batch read`,
        );
        out.push(...r.results);
      }
      return out;
    };

    const propertyEvents = (t: ZTicket, createdAt: Date) => {
      const events: CanonicalEvent[] = [];
      const initial: Record<string, string | null> = {};
      const hist = t.propertiesWithHistory ?? {};
      for (const prop of HISTORY_PROPERTIES) {
        const entries = [...(hist[prop] ?? [])].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        if (entries.length === 0) {
          initial[prop] = t.properties[prop] || null;
          continue;
        }
        // Initial value: the last entry at/before creation, else the oldest.
        let initIdx = -1;
        entries.forEach((e, i) => {
          if (Date.parse(e.timestamp) <= createdAt.getTime()) initIdx = i;
        });
        if (initIdx === -1) initIdx = 0;
        initial[prop] = entries[initIdx]?.value || null;
        entries.forEach((e, i) => {
          if (i <= initIdx) return;
          const at = parseTime(e.timestamp, `${prop} history`);
          const raw = e.value || null;
          const idempotencyKey = `hubspot:ticket:${t.id}:${prop}:${e.timestamp}:${e.value ?? ""}`;
          if (prop === "hs_pipeline_stage" && raw) {
            events.push({
              type: "status_changed",
              at,
              status: mapStatus(ctx.mapping, raw).value,
              rawStatus: raw,
              idempotencyKey,
            });
          } else if (prop === "hs_ticket_priority") {
            events.push({
              type: "priority_changed",
              at,
              priority: mapPriority(ctx.mapping, raw).value,
              rawPriority: raw,
              idempotencyKey,
            });
          } else if (prop === "hubspot_owner_id") {
            events.push({ type: "assignee_changed", at, assigneeSourceId: raw, idempotencyKey });
          }
        });
      }
      return { events, initial };
    };

    return {
      async testConnection() {
        const r = parseAs(
          z.object({ portalId: id, uiDomain: z.string().nullish() }).loose(),
          await http.get("/account-info/v3/details"),
          "account details",
        );
        return { accountName: `HubSpot portal ${r.portalId}`, accountId: r.portalId };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { since: number; after?: string } =>
          typeof (v as { since?: unknown })?.since === "number" &&
          ["string", "undefined"].includes(typeof (v as { after?: unknown }).after);
        const state = decodeCursor(cursor, isState) ?? { since: since.getTime() };
        const body: Record<string, unknown> = {
          filterGroups: [
            { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(state.since) }] },
          ],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
          properties: TICKET_PROPERTIES,
          limit: 100,
        };
        if (state.after) body.after = state.after;
        const r = parseAs(zSearch, await http.post("/crm/v3/objects/tickets/search", body), "ticket search");
        const items = r.results.map((t) => snapshot(t));
        const after = r.paging?.next?.after;
        let nextCursor: string | null = null;
        if (after) {
          const last = items.at(-1);
          if (Number(after) >= SEARCH_REANCHOR_AT && last) {
            // Re-anchored pages may repeat tickets with the same timestamp; the worker dedupes.
            nextCursor = encodeCursor({ since: last.updatedAt.getTime() });
          } else {
            nextCursor = encodeCursor({ since: state.since, after });
          }
        }
        return { items, nextCursor };
      },

      async getTicketWithHistory(sourceId) {
        const t = parseAs(
          zTicket,
          await http.get(`/crm/v3/objects/tickets/${encodeURIComponent(sourceId)}`, {
            query: {
              properties: TICKET_PROPERTIES.join(","),
              propertiesWithHistory: HISTORY_PROPERTIES.join(","),
              associations: "emails,notes,contacts,companies",
            },
          }),
          "ticket",
        );
        const assoc = (k: "emails" | "notes" | "contacts" | "companies") => [
          ...new Set((t.associations?.[k]?.results ?? []).map((a) => a.id)),
        ];
        const [emails, notes, contacts, companies] = [
          await batchRead("emails", assoc("emails"), [
            "hs_timestamp",
            "hs_email_direction",
            "hs_email_text",
            "hs_email_html",
            "hs_email_subject",
            "hubspot_owner_id",
            "hs_email_status",
          ]),
          await batchRead("notes", assoc("notes"), ["hs_timestamp", "hs_note_body", "hubspot_owner_id"]),
          await batchRead("contacts", assoc("contacts").slice(0, 1), ["email", "firstname", "lastname"]),
          await batchRead("companies", assoc("companies").slice(0, 1), ["name", "domain"]),
        ];

        const ticket = snapshot(t, { contact: contacts[0], company: companies[0] });
        const createdAt = ticket.createdAt;
        const { events: changes, initial } = propertyEvents(t, createdAt);
        const events: CanonicalEvent[] = [
          {
            type: "created",
            at: createdAt,
            status: initial.hs_pipeline_stage ? mapStatus(ctx.mapping, initial.hs_pipeline_stage).value : "new",
            priority: mapPriority(ctx.mapping, initial.hs_ticket_priority).value,
            idempotencyKey: `hubspot:ticket:${t.id}:created`,
          },
        ];
        if (initial.hubspot_owner_id) {
          events.push({
            type: "assignee_changed",
            at: createdAt,
            assigneeSourceId: initial.hubspot_owner_id,
            idempotencyKey: `hubspot:ticket:${t.id}:owner:initial`,
          });
        }
        const comments: CanonicalComment[] = [];
        const addComment = (c: CanonicalComment, eventAuthor: AuthorRole, key: string) => {
          comments.push(c);
          events.push({
            type: "comment",
            at: c.at,
            author: eventAuthor,
            public: c.public,
            commentSourceId: c.sourceId,
            idempotencyKey: key,
          });
        };
        const content = plainText(t.properties.content);
        if (content) {
          addComment(
            {
              sourceId: `${t.id}:content`,
              at: createdAt,
              authorRole: "requester",
              authorName: ticket.requester.name,
              authorSourceId: ticket.requester.sourceId,
              public: true,
              bodyText: content,
            },
            openingEventAuthor("requester"),
            `hubspot:ticket:${t.id}:content`,
          );
        }
        for (const e of emails) {
          const p = e.properties;
          const role: AuthorRole = p.hs_email_direction === "INCOMING_EMAIL" ? "requester" : "agent";
          addComment(
            {
              sourceId: e.id,
              at: parseTime(p.hs_timestamp ?? e.createdAt, `email ${e.id}`),
              authorRole: role,
              authorName: null,
              authorSourceId: role === "agent" ? (p.hubspot_owner_id ?? null) : ticket.requester.sourceId,
              public: true,
              bodyText: p.hs_email_text ? plainText(p.hs_email_text) : htmlToText(p.hs_email_html),
            },
            role,
            `hubspot:email:${e.id}`,
          );
        }
        for (const n of notes) {
          const p = n.properties;
          addComment(
            {
              sourceId: n.id,
              at: parseTime(p.hs_timestamp ?? n.createdAt, `note ${n.id}`),
              authorRole: "agent",
              authorName: null,
              authorSourceId: p.hubspot_owner_id ?? null,
              public: false,
              bodyText: htmlToText(p.hs_note_body),
            },
            "agent",
            `hubspot:note:${n.id}`,
          );
        }
        events.push(...changes);
        comments.sort((a, b) => a.at.getTime() - b.at.getTime());
        return { ticket, events: dropNoopChanges(finalizeEvents(events)), comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const sig = header(req.headers, "x-hubspot-signature-v3");
        const ts = header(req.headers, "x-hubspot-request-timestamp");
        if (!sig || !ts || !/^\d+$/.test(ts)) return { ok: false, reason: "bad_signature" };
        if (Math.abs(Date.now() - Number(ts)) > WEBHOOK_MAX_AGE_MS) return { ok: false, reason: "bad_signature" };
        const expected = hmac("sha256", secret, `POST${decodeHubspotUri(req.url)}${req.rawBody}${ts}`, "base64");
        if (!safeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const ids = new Set<string>();
        for (const e of parsed.data) {
          const kind = e.subscriptionType ?? e.eventType ?? "";
          if (kind.startsWith("ticket.") || e.objectTypeId === "0-5") ids.add(e.objectId);
        }
        return { ok: true, ticketSourceIds: [...ids] };
      },

      async postInternalNote(sourceId, body) {
        const r = parseAs(
          z.object({ id }).loose(),
          await http.post("/crm/v3/objects/notes", {
            properties: { hs_timestamp: new Date().toISOString(), hs_note_body: textToHtml(body) },
            associations: [
              {
                to: { id: sourceId },
                types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_TICKET }],
              },
            ],
          }),
          "create note",
        );
        return { commentSourceId: r.id };
      },

      async postPublicReply() {
        throw new ConnectorError(
          "HubSpot public replies need the Conversations inbox thread; not supported by this connector",
          "unsupported",
        );
      },

      async updateTicket(sourceId, patch) {
        if (patch.addTags?.length) throw new ConnectorError("HubSpot tickets have no tags", "unsupported");
        const properties: Record<string, string> = {};
        if (patch.priority) {
          properties.hs_ticket_priority = rawPriorityFor(ctx.mapping, patch.priority) ?? patch.priority.toUpperCase();
        }
        if (patch.assigneeSourceId !== undefined) properties.hubspot_owner_id = patch.assigneeSourceId;
        if (Object.keys(properties).length === 0) return;
        await http.patch(`/crm/v3/objects/tickets/${encodeURIComponent(sourceId)}`, { properties });
      },
    };
  },
};
