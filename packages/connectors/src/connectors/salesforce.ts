/**
 * Salesforce Service Cloud connector (the Case object).
 *
 * API docs (verified 2026-09):
 * - OAuth client credentials flow (External Client App, run-as integration user):
 *   https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&type=5
 *   and https://help.salesforce.com/s/articleView?id=xcloud.meta_configure_client_credentials_flow_for_external_client_apps.htm&type=5
 * - OAuth refresh token flow: https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_refresh_token_flow.htm&type=5
 * - REST API guide (v68.0 is Winter '27; v66.0 Spring '26, v67.0 Summer '26):
 *   https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_rest.pdf
 * - SOQL query + `nextRecordsUrl` pagination: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_query.htm
 * - Update a record (PATCH, 204): https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_update_fields.htm
 * - Create a record: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_sobject_create.htm
 * - Objects: Case, CaseHistory, CaseComment, EmailMessage, User (UserType):
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_case.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_casehistory.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_casecomment.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_emailmessage.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_user.htm
 * - API limits (daily limit → 403 REQUEST_LIMIT_EXCEEDED):
 *   https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_api.htm
 * - Change Data Capture / Pub/Sub API (why there are no webhooks here):
 *   https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_intro.htm
 *   https://developer.salesforce.com/docs/platform/pub-sub-api/overview
 *
 * Auth: an External Client App (new Connected Apps are off by default since
 * Spring '26) with the client credentials flow, or any app with a refresh token.
 * The access token is fetched through the injected fetch, cached in the
 * create() closure, and refreshed once on a 401 (INVALID_SESSION_ID).
 *
 * History comes from CaseHistory (field history tracking must be enabled for
 * Status, Priority and Owner, otherwise only the "created" row exists and the
 * stream shows current values only), EmailMessage (Email-to-Case) and
 * CaseComment. Not verified without a live org: the exact DataType label on
 * Status/Priority history rows (we read NewValue regardless of DataType), and
 * that Owner changes always produce an EntityId row alongside the Text row.
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { buildUrl, detectRateLimits, HttpClient, requestToken, retryOnceOnAuth } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { htmlToText, plainText } from "../lib/text.js";
import { parseAs } from "../lib/validate.js";
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

/**
 * Pinned REST API version. v66.0 (Spring '26) is on every org today; Winter '27
 * (v68.0) is still rolling out in late Sept 2026. Bump deliberately.
 */
export const SALESFORCE_API_VERSION = "v66.0";
const DATA = `/services/data/${SALESFORCE_API_VERSION}`;

/**
 * One flat object (the connect form and the registry read `.shape`): with a
 * refresh token we use the refresh_token grant, without one the
 * client_credentials grant against the org's My Domain URL.
 */
const credentialsSchema = z.object({
  instanceUrl: z
    .url({ protocol: /^https$/ })
    .transform((u) => new URL(u).origin)
    .describe("My Domain URL, e.g. https://acme.my.salesforce.com"),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type SalesforceCredentials = z.infer<typeof credentialsSchema>;

const sfId = z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/);
const configSchema = z
  .object({
    /** Extra users (e.g. an integration or flow user) whose comments count as bot replies. */
    botUserIds: z.array(sfId).default([]),
  })
  .loose();

const defaultMapping: FieldMapping = {
  status: {
    New: "new",
    Working: "open",
    Escalated: "open",
    "In Progress": "open",
    "Waiting on Customer": "pending",
    "Awaiting Customer": "pending",
    Pending: "pending",
    "On Hold": "on_hold",
    "Waiting on Third Party": "on_hold",
    Resolved: "solved",
    Closed: "closed",
  },
  priority: { Critical: "urgent", Urgent: "urgent", High: "high", Medium: "normal", Low: "low" },
};

const zToken = z.object({ access_token: z.string().min(1), instance_url: z.url() });

const zCase = z.object({
  Id: z.string(),
  CaseNumber: z.string().nullish(),
  Subject: z.string().nullish(),
  Description: z.string().nullish(),
  Status: z.string().nullish(),
  Priority: z.string().nullish(),
  IsClosed: z.boolean().nullish(),
  Origin: z.string().nullish(),
  OwnerId: z.string().nullish(),
  Owner: z.object({ Name: z.string().nullish() }).nullish(),
  ContactId: z.string().nullish(),
  ContactEmail: z.string().nullish(),
  Contact: z.object({ Name: z.string().nullish() }).nullish(),
  AccountId: z.string().nullish(),
  Account: z.object({ Name: z.string().nullish() }).nullish(),
  CreatedDate: z.string(),
  SystemModstamp: z.string(),
});
type ZCase = z.infer<typeof zCase>;

const zHistory = z.object({
  Id: z.string(),
  Field: z.string(),
  DataType: z.string().nullish(),
  // anyType on the wire: string, number, boolean or null.
  OldValue: z.unknown(),
  NewValue: z.unknown(),
  CreatedDate: z.string(),
});

const zCreatedBy = z.object({ Name: z.string().nullish(), UserType: z.string().nullish() }).nullish();
const zComment = z.object({
  Id: z.string(),
  IsPublished: z.boolean().nullish(),
  CommentBody: z.string().nullish(),
  CreatedDate: z.string(),
  CreatedById: z.string().nullish(),
  CreatedBy: zCreatedBy,
});
const zEmail = z.object({
  Id: z.string(),
  Incoming: z.boolean().nullish(),
  FromName: z.string().nullish(),
  FromAddress: z.string().nullish(),
  TextBody: z.string().nullish(),
  HtmlBody: z.string().nullish(),
  CreatedDate: z.string(),
  CreatedById: z.string().nullish(),
  CreatedBy: zCreatedBy,
});

const queryResult = <T extends z.ZodType>(record: T) =>
  z.object({ records: z.array(record), done: z.boolean().nullish(), nextRecordsUrl: z.string().nullish() });

const CASE_FIELDS = [
  "Id",
  "CaseNumber",
  "Subject",
  "Description",
  "Status",
  "Priority",
  "IsClosed",
  "Origin",
  "OwnerId",
  "Owner.Name",
  "ContactId",
  "ContactEmail",
  "Contact.Name",
  "AccountId",
  "Account.Name",
  "CreatedDate",
  "SystemModstamp",
].join(", ");

/** Only relative query-locator paths may come back through a cursor (never another host). */
const NEXT_RECORDS = /^\/services\/data\/v\d+\.\d+\/query\/[A-Za-z0-9-]+$/;

const USER_ID = /^005/;
/** Portal/Experience Cloud users are customers; the Automated Process user is a bot. */
const CUSTOMER_USER_TYPES = new Set(["CspLitePortal", "CustomerSuccess", "PowerCustomerSuccess", "Guest"]);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** SOQL datetime literal (no quotes, whole seconds). */
function soqlDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

function checkId(sourceId: string): string {
  if (!sfId.safeParse(sourceId).success) throw new ConnectorError(`not a Salesforce record id: ${sourceId}`, "invalid");
  return sourceId;
}

export const salesforce: ConnectorDefinition<SalesforceCredentials> = {
  provider: "salesforce",
  displayName: "Salesforce Service Cloud",
  authKind: "oauth2",
  credentialsSchema,
  credentialFields: [
    {
      key: "instanceUrl",
      label: "My Domain URL",
      secret: false,
      placeholder: "https://acme.my.salesforce.com",
    },
    {
      key: "clientId",
      label: "Consumer key",
      secret: false,
      help: "Setup → External Client App Manager → your app → OAuth Settings. Enable the client credentials flow and set a run-as integration user.",
    },
    { key: "clientSecret", label: "Consumer secret", secret: true },
    {
      key: "refreshToken",
      label: "Refresh token (optional)",
      secret: true,
      help: "Only if your app uses the web-server flow instead of client credentials.",
    },
  ],
  // CDC and Platform Events need a streaming client (CometD or Pub/Sub API over
  // gRPC); a stateless HTTP adapter can't hold that subscription, so the worker polls.
  supportsWebhooks: false,
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: false },
  defaultMapping,
  docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm",
  create(ctx: ConnectorContext<SalesforceCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const cfg = configSchema.parse(ctx.config ?? {});
    const botUsers = new Set(cfg.botUserIds);
    const host = new URL(creds.instanceUrl).host;
    const key = (...parts: (string | number)[]) => ["salesforce", host, ...parts].join(":");

    let session: { http: HttpClient; instanceUrl: string } | null = null;

    /** Client credentials, or the refresh token grant when the app uses the web-server flow. */
    const fetchToken = async (): Promise<{ http: HttpClient; instanceUrl: string }> => {
      const data = await requestToken({
        fetch: ctx.fetch,
        signal: ctx.signal,
        url: buildUrl(creds.instanceUrl, "/services/oauth2/token"),
        // Salesforce answers bad client credentials/refresh tokens with 400 invalid_client/invalid_grant.
        params: creds.refreshToken
          ? {
              grant_type: "refresh_token",
              client_id: creds.clientId,
              client_secret: creds.clientSecret,
              refresh_token: creds.refreshToken,
            }
          : { grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret },
      });
      const tok = parseAs(zToken, data, "oauth token");
      const instanceUrl = new URL(tok.instance_url).origin;
      return {
        instanceUrl,
        http: new HttpClient({
          baseUrl: instanceUrl,
          // The daily API allocation is a 403 REQUEST_LIMIT_EXCEEDED, not a 429.
          fetch: detectRateLimits(ctx.fetch, {
            statuses: [401, 403],
            readBody: true,
            test: (_res, body) => body.includes("REQUEST_LIMIT_EXCEEDED"),
          }),
          signal: ctx.signal,
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }),
      };
    };

    /** Runs a request with the cached token; on a 401 fetches a new token once and retries. */
    const api = async <T>(fn: (http: HttpClient) => Promise<T>): Promise<T> => {
      session ??= await fetchToken();
      return retryOnceOnAuth(() => fn(session!.http), {
        onAuthFailure: async () => {
          session = null;
          session = await fetchToken();
        },
      });
    };

    const query = <T extends z.ZodType>(soql: string, record: T, what: string) =>
      api(async (http) =>
        collectPages<z.output<T>, { q: string } | { next: string }>({ q: soql }, async (tok) => {
          const raw = "q" in tok ? await http.get(`${DATA}/query`, { query: { q: tok.q } }) : await http.get(tok.next);
          const r = parseAs(queryResult(record), raw, what);
          return { items: r.records, next: r.nextRecordsUrl ? { next: r.nextRecordsUrl } : null };
        }),
      );

    /**
     * Unmapped raw status: when the case is closed (IsClosed, driven by the
     * CaseStatus picklist's "Closed" flag) and the raw value is the case's
     * current status, it maps to closed instead of the open default. The value
     * is still flagged so the customer maps it explicitly.
     */
    const statusFor = (raw: string, c: ZCase) => {
      const m = mapStatus(ctx.mapping, raw);
      if (!m.known && c.IsClosed === true && raw === c.Status) return { value: "closed" as const, known: false };
      return m;
    };

    const snapshot = (c: ZCase): CanonicalTicket => {
      const rawStatus = c.Status ?? "New";
      const rawPriority = c.Priority || null;
      const m = mappingIssues(ctx.mapping, rawStatus, rawPriority);
      const s = statusFor(rawStatus, c);
      const owner = c.OwnerId ?? null;
      return {
        ref: {
          sourceId: c.Id,
          displayKey: c.CaseNumber ? `#${c.CaseNumber}` : c.Id,
          url: `${creds.instanceUrl}/lightning/r/Case/${c.Id}/view`,
        },
        subject: c.Subject ?? "",
        status: s.value,
        rawStatus,
        priority: m.priority,
        rawPriority,
        requester: {
          sourceId: c.ContactId ?? null,
          email: c.ContactEmail ?? null,
          name: c.Contact?.Name ?? null,
          orgSourceId: c.AccountId ?? null,
          orgName: c.Account?.Name ?? null,
        },
        // OwnerId is a user (005…) or a queue (00G…); a queue is the case's group.
        assignee: owner && USER_ID.test(owner) ? { sourceId: owner, name: c.Owner?.Name ?? null } : null,
        groupSourceId: owner && !USER_ID.test(owner) ? owner : null,
        tags: [],
        channel: c.Origin ? c.Origin.toLowerCase() : null,
        createdAt: parseTime(c.CreatedDate, "Case.CreatedDate"),
        updatedAt: parseTime(c.SystemModstamp, "Case.SystemModstamp"),
        mappingIssues: m.issues,
      };
    };

    /**
     * Comment author: the Automated Process user and configured bot users are
     * bots; portal/Experience Cloud and guest users are the customer; every
     * other internal user is an agent. (An integration user on a Salesforce
     * Integration license is UserType Standard, so it can only be recognised
     * through `config.botUserIds`.)
     */
    const userRole = (userId: string | null | undefined, userType: string | null | undefined): AuthorRole => {
      if (userType === "AutomatedProcess" || (userId && botUsers.has(userId))) return "bot";
      if (userType && CUSTOMER_USER_TYPES.has(userType)) return "requester";
      return "agent";
    };

    const getCase = async (sourceId: string): Promise<ZCase> => {
      const [c] = await query(`SELECT ${CASE_FIELDS} FROM Case WHERE Id = '${checkId(sourceId)}'`, zCase, "case");
      if (!c) throw new ConnectorError(`Salesforce case ${sourceId} not found`, "not_found");
      return c;
    };

    return {
      async testConnection() {
        const [org] = await query(
          "SELECT Id, Name FROM Organization LIMIT 1",
          z.object({ Id: z.string(), Name: z.string().nullish() }),
          "organization",
        );
        if (!org) throw new ConnectorError("Salesforce: organization not readable", "auth");
        return { accountName: org.Name ?? host, accountId: org.Id };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { next: string } =>
          typeof (v as { next?: unknown })?.next === "string" && NEXT_RECORDS.test((v as { next: string }).next);
        const state = decodeCursor(cursor, isState);
        // SystemModstamp also moves on system changes (indexed; LastModifiedDate isn't).
        const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE SystemModstamp >= ${soqlDateTime(since)} ORDER BY SystemModstamp, Id`;
        const r = await api(async (http) =>
          parseAs(
            queryResult(zCase),
            state ? await http.get(state.next) : await http.get(`${DATA}/query`, { query: { q: soql } }),
            "case query",
          ),
        );
        // Query locators expire after ~15 minutes idle; an expired cursor fails
        // with INVALID_QUERY_LOCATOR and the worker restarts from its watermark.
        return {
          items: r.records.map(snapshot),
          nextCursor: r.nextRecordsUrl ? encodeCursor({ next: r.nextRecordsUrl }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const c = await getCase(sourceId);
        const hist = await query(
          `SELECT Id, Field, DataType, OldValue, NewValue, CreatedDate FROM CaseHistory WHERE CaseId = '${c.Id}' ORDER BY CreatedDate, Id`,
          zHistory,
          "case history",
        );
        const caseComments = await query(
          `SELECT Id, IsPublished, CommentBody, CreatedDate, CreatedById, CreatedBy.Name, CreatedBy.UserType FROM CaseComment WHERE ParentId = '${c.Id}' ORDER BY CreatedDate, Id`,
          zComment,
          "case comments",
        );
        const emails = await query(
          `SELECT Id, Incoming, FromName, FromAddress, TextBody, HtmlBody, CreatedDate, CreatedById, CreatedBy.Name, CreatedBy.UserType FROM EmailMessage WHERE ParentId = '${c.Id}' ORDER BY CreatedDate, Id`,
          zEmail,
          "email messages",
        );

        const firstOld = (field: string) => str(hist.find((h) => h.Field === field)?.OldValue);
        const createdAt = parseTime(
          hist.find((h) => h.Field === "created")?.CreatedDate ?? c.CreatedDate,
          "case created",
        );
        const events: CanonicalEvent[] = [
          {
            type: "created",
            at: createdAt,
            status: statusFor(firstOld("Status") ?? c.Status ?? "New", c).value,
            priority: mapPriority(ctx.mapping, firstOld("Priority") ?? c.Priority ?? null).value,
            idempotencyKey: key("case", c.Id, "created"),
          },
        ];
        for (const h of hist) {
          const at = parseTime(h.CreatedDate, `CaseHistory ${h.Id}`);
          const k = key("history", h.Id);
          const to = str(h.NewValue);
          if (h.Field === "Status" && to) {
            events.push({
              type: "status_changed",
              at,
              status: statusFor(to, c).value,
              rawStatus: to,
              idempotencyKey: k,
            });
          } else if (h.Field === "Priority") {
            events.push({
              type: "priority_changed",
              at,
              priority: mapPriority(ctx.mapping, to).value,
              rawPriority: to,
              idempotencyKey: k,
            });
          } else if ((h.Field === "Owner" || h.Field === "ownerAssignment") && h.DataType === "EntityId") {
            // Owner changes log two rows (EntityId with ids, Text with names); keep the id row.
            // A move to a queue (00G…) leaves the case unassigned.
            events.push({
              type: "assignee_changed",
              at,
              assigneeSourceId: to && USER_ID.test(to) ? to : null,
              idempotencyKey: k,
            });
          }
        }

        type Msg = { comment: CanonicalComment; key: string };
        const msgs: Msg[] = [
          ...emails.map((e): Msg => {
            // Incoming mail is the customer's; outgoing mail is an agent's unless sent by automation.
            const role: AuthorRole = e.Incoming
              ? "requester"
              : userRole(e.CreatedById, e.CreatedBy?.UserType) === "bot"
                ? "bot"
                : "agent";
            return {
              key: key("email", e.Id),
              comment: {
                sourceId: e.Id,
                // CreatedDate is Salesforce's receive/send time; MessageDate is the sender's clock.
                at: parseTime(e.CreatedDate, `EmailMessage ${e.Id}`),
                authorRole: role,
                authorName: e.FromName ?? e.FromAddress ?? null,
                authorSourceId: e.Incoming ? (c.ContactId ?? null) : (e.CreatedById ?? null),
                public: true,
                bodyText: e.TextBody ? plainText(e.TextBody) : htmlToText(e.HtmlBody),
              },
            };
          }),
          ...caseComments.map(
            (cc): Msg => ({
              key: key("comment", cc.Id),
              comment: {
                sourceId: cc.Id,
                at: parseTime(cc.CreatedDate, `CaseComment ${cc.Id}`),
                authorRole: userRole(cc.CreatedById, cc.CreatedBy?.UserType),
                authorName: cc.CreatedBy?.Name ?? null,
                authorSourceId: cc.CreatedById ?? null,
                public: cc.IsPublished === true,
                bodyText: plainText(cc.CommentBody),
              },
            }),
          ),
        ].sort((a, b) => a.comment.at.getTime() - b.comment.at.getTime());

        // The case Description is the customer's opening message (web, phone,
        // portal). Email-to-Case copies the first incoming email into it, so it's
        // skipped when the first message is already an incoming email.
        const first = msgs[0]?.comment;
        const firstIsIncomingEmail = first !== undefined && emails.some((e) => e.Id === first.sourceId && e.Incoming);
        if (c.Description && !firstIsIncomingEmail) {
          msgs.unshift({
            key: key("case", c.Id, "description"),
            comment: {
              sourceId: `${c.Id}:description`,
              at: createdAt,
              authorRole: "requester",
              authorName: c.Contact?.Name ?? null,
              authorSourceId: c.ContactId ?? null,
              public: true,
              bodyText: plainText(c.Description),
            },
          });
        }

        msgs.forEach((m, i) => {
          events.push({
            type: "comment",
            at: m.comment.at,
            author: i === 0 ? openingEventAuthor(m.comment.authorRole) : m.comment.authorRole,
            public: m.comment.public,
            commentSourceId: m.comment.sourceId,
            idempotencyKey: m.key,
          });
        });

        return {
          ticket: snapshot(c),
          events: dropNoopChanges(finalizeEvents(events)),
          comments: msgs.map((m) => m.comment),
        };
      },

      async handleWebhook() {
        // No HTTP webhooks: Case changes arrive via Change Data Capture or Platform
        // Events, which need a streaming subscriber (CometD, or Pub/Sub API over
        // gRPC). The worker polls listUpdatedTickets instead.
        return { ok: false, reason: "unsupported" };
      },

      async postInternalNote(sourceId, body) {
        const r = parseAs(
          z.object({ id: z.string() }),
          await api((http) =>
            http.post(`${DATA}/sobjects/CaseComment`, {
              ParentId: checkId(sourceId),
              CommentBody: body,
              IsPublished: false,
            }),
          ),
          "create case comment",
        );
        return { commentSourceId: r.id };
      },

      async postPublicReply(sourceId, body) {
        // A published comment is visible in the portal; the contact is emailed
        // only when the org enables case comment notifications to contacts.
        const r = parseAs(
          z.object({ id: z.string() }),
          await api((http) =>
            http.post(`${DATA}/sobjects/CaseComment`, {
              ParentId: checkId(sourceId),
              CommentBody: body,
              IsPublished: true,
            }),
          ),
          "create case comment",
        );
        return { commentSourceId: r.id };
      },

      async updateTicket(sourceId, patch) {
        if (patch.addTags?.length) throw new ConnectorError("Salesforce cases have no tags", "unsupported");
        const fields: Record<string, string> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (!raw) throw new ConnectorError(`no Salesforce priority is mapped to "${patch.priority}"`, "invalid");
          fields.Priority = raw;
        }
        if (patch.assigneeSourceId !== undefined) fields.OwnerId = checkId(patch.assigneeSourceId);
        if (Object.keys(fields).length === 0) return;
        const id = checkId(sourceId);
        await api((http) => http.patch(`${DATA}/sobjects/Case/${id}`, fields));
      },
    };
  },
};
