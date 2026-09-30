/**
 * Linear connector (an escalation target, not a customer-facing help desk).
 *
 * API docs (verified 2026-09):
 * - GraphQL endpoint + auth (personal API key: `Authorization: <key>`, no
 *   Bearer; OAuth: `Bearer <token>`) + error envelope: https://linear.app/developers/graphql
 * - Pagination (first/after, pageInfo { hasNextPage endCursor }, orderBy updatedAt): https://linear.app/developers/pagination
 * - Filtering (updatedAt: { gte }, relation filters): https://linear.app/developers/filtering
 * - Rate limiting (HTTP 400 + errors[].extensions.code "RATELIMITED",
 *   X-RateLimit-*-Reset in epoch ms, no Retry-After documented): https://linear.app/developers/rate-limiting
 * - Webhooks (`Linear-Signature` = hex HMAC-SHA256 of the raw body;
 *   `webhookTimestamp` in ms, reject if more than 60 s off): https://linear.app/developers/webhooks
 * - Schema (IssueHistory, Comment.externalUser/botActor, CustomerNeed.comment,
 *   IssueUpdateInput.addedLabelIds, WorkflowState.type values):
 *   https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
 *
 * Not verifiable from the docs (need a real workspace to confirm):
 * - the error `extensions.code` values other than RATELIMITED
 *   (AUTHENTICATION_ERROR / FORBIDDEN / INVALID_INPUT are what the API is
 *   observed to send; "Entity not found" is matched on the message);
 * - the maximum `first` (we cap pageSize at 250);
 * - the order of `issue.history` nodes (we sort by createdAt ourselves).
 *
 * Status mapping: rawStatus is the workflow state *name* (states are per
 * team and customisable). Lookup is by name first, then by the state's `type`
 * under the key "type:<type>". A mapping issue is flagged only when neither
 * the name nor the type is mapped.
 *
 * Priority: raw values are Linear's numeric priority as a string: "0" = no
 * priority (null), "1" Urgent, "2" High, "3" Medium, "4" Low.
 *
 * Comment visibility rule: Linear issues have no customer channel, so every
 * comment is an internal note, except customer-sourced ones, which count as
 * public requester messages: a comment with `externalUser` set (Slack /
 * Linear Asks / synced threads from people outside the workspace), or a
 * comment that is the source of a Customer Need (a customer request). A
 * comment with `botActor` (integration/automation) is a bot. The issue
 * description is the opening message: from the requester when the issue was
 * created by an external user (Asks / customer request), else from the agent.
 *
 * Writes: internal notes (commentCreate), priority/assignee/labels
 * (issueUpdate; label names resolve to ids, preferring the issue's team labels
 * over workspace labels). Public replies are unsupported.
 */
import type { AuthorRole } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, verifyHmac } from "../lib/hmac.js";
import { HttpClient } from "../lib/http.js";
import { mapPriority, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor } from "../lib/paginate.js";
import { plainText } from "../lib/text.js";
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
  type MappingIssue,
} from "../types.js";

const API_URL = "https://api.linear.app/graphql";
const WEBHOOK_TOLERANCE_MS = 60_000;

const credentialsSchema = z.object({ apiKey: z.string().trim().min(1) });
export type LinearCredentials = z.infer<typeof credentialsSchema>;

const configSchema = z
  .object({
    teamId: z.string().min(1).optional(),
    teamKey: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(250).default(50),
  })
  .loose();

const defaultMapping: FieldMapping = {
  status: {
    // Sample custom state names (matched before the type).
    "Waiting on customer": "pending",
    "Waiting on vendor": "on_hold",
    // Fallback by WorkflowState.type.
    "type:triage": "new",
    "type:backlog": "open",
    "type:unstarted": "open",
    "type:started": "open",
    "type:completed": "solved",
    "type:canceled": "closed",
    "type:duplicate": "closed",
  },
  priority: { "0": null, "1": "urgent", "2": "high", "3": "normal", "4": "low" },
};

const zPageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });
const zState = z.object({ id: z.string(), name: z.string(), type: z.string() });
const zUser = z.object({ id: z.string(), name: z.string().nullish(), email: z.string().nullish() });
const zNamed = z.object({ id: z.string(), name: z.string().nullish() });

const zIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string().nullish(),
  priority: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  integrationSourceType: z.string().nullish(),
  state: zState,
  team: z.object({ id: z.string(), key: z.string().nullish() }),
  assignee: zUser.nullish(),
  creator: zUser.nullish(),
  botActor: zNamed.nullish(),
  externalUserCreator: zUser.nullish(),
  asksRequester: zUser.nullish(),
  asksExternalUserRequester: zUser.nullish(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }),
  needs: z.object({
    nodes: z.array(z.object({ comment: z.object({ id: z.string() }).nullish(), customer: zNamed.nullish() })),
  }),
});
type ZIssue = z.infer<typeof zIssue>;

const zHistory = z.object({
  id: z.string(),
  createdAt: z.string(),
  fromState: zState.nullish(),
  toState: zState.nullish(),
  fromPriority: z.number().nullish(),
  toPriority: z.number().nullish(),
  fromAssigneeId: z.string().nullish(),
  toAssigneeId: z.string().nullish(),
  addedLabels: z.array(z.object({ name: z.string() })).nullish(),
  removedLabels: z.array(z.object({ name: z.string() })).nullish(),
});

const zComment = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  user: zUser.nullish(),
  botActor: zNamed.nullish(),
  externalUser: zUser.nullish(),
});

const connection = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node), pageInfo: zPageInfo });

const ISSUE_FIELDS = `
  id identifier title description url priority createdAt updatedAt integrationSourceType
  state { id name type }
  team { id key }
  assignee { id name email }
  creator { id name email }
  botActor { id name }
  externalUserCreator { id name email }
  asksRequester { id name email }
  asksExternalUserRequester { id name email }
  labels(first: 50) { nodes { id name } }
  needs(first: 50) { nodes { comment { id } customer { id name } } }
`;
const HISTORY_FIELDS = `
  id createdAt
  fromState { id name type } toState { id name type }
  fromPriority toPriority fromAssigneeId toAssigneeId
  addedLabels { name } removedLabels { name }
`;
const COMMENT_FIELDS = `
  id body createdAt
  user { id name email }
  botActor { id name }
  externalUser { id name email }
`;

export const VIEWER_QUERY = "query Viewer { viewer { id name } organization { id name urlKey } }";

export const ISSUES_QUERY = `query UpdatedIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const ISSUE_QUERY = `query IssueWithHistory($id: String!) {
  organization { urlKey }
  issue(id: $id) {
    ${ISSUE_FIELDS}
    history(first: 100) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } }
    comments(first: 100) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }
  }
}`;

export const HISTORY_PAGE_QUERY = `query IssueHistory($id: String!, $after: String) {
  issue(id: $id) { history(first: 100, after: $after) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`;

export const COMMENTS_PAGE_QUERY = `query IssueComments($id: String!, $after: String) {
  issue(id: $id) { comments(first: 100, after: $after) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`;

export const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

export const ISSUE_LABELS_QUERY = `query IssueLabels($id: String!, $names: [String!]!) {
  issue(id: $id) { team { id } }
  issueLabels(filter: { name: { in: $names } }, first: 250) { nodes { id name team { id } } }
}`;

export const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const zWebhook = z
  .object({
    type: z.string(),
    webhookTimestamp: z.number(),
    data: z.object({ id: z.string().nullish(), issueId: z.string().nullish() }).loose(),
  })
  .loose();

const zEnvelope = z.object({
  data: z.unknown().nullish(),
  errors: z
    .array(
      z
        .object({
          message: z.string().nullish(),
          extensions: z.object({ code: z.string().nullish() }).loose().nullish(),
        })
        .loose(),
    )
    .nullish(),
});

const RESET_HEADERS = [
  "x-ratelimit-requests-reset",
  "x-ratelimit-complexity-reset",
  "x-ratelimit-endpoint-requests-reset",
];

/** Linear sends reset instants (epoch ms), not Retry-After; use the latest one. */
function retryAfterFromReset(headers: Headers): number | null {
  let latest: number | null = null;
  for (const h of RESET_HEADERS) {
    const v = headers.get(h);
    if (v && /^\d+$/.test(v.trim())) latest = Math.max(latest ?? 0, Number(v));
  }
  return latest === null ? null : Math.max(0, latest - Date.now());
}

function errorCode(body: unknown): { code: string; message: string } | null {
  const env = zEnvelope.safeParse(body);
  const first = env.success ? env.data.errors?.[0] : undefined;
  if (!first) return null;
  return { code: first.extensions?.code ?? "", message: first.message ?? "" };
}

function toConnectorError(e: { code: string; message: string }, retryAfterMs: number | null): ConnectorError {
  const msg = `Linear GraphQL error ${e.code || "(no code)"}: ${e.message.slice(0, 200)}`;
  switch (e.code) {
    case "RATELIMITED":
      return new ConnectorError(msg, "rate_limited", retryAfterMs);
    case "AUTHENTICATION_ERROR":
    case "FORBIDDEN":
      return new ConnectorError(msg, "auth");
  }
  if (/not found/i.test(e.message)) return new ConnectorError(msg, "not_found");
  if (e.code === "INVALID_INPUT" || e.code === "GRAPHQL_VALIDATION_FAILED" || e.code === "BAD_USER_INPUT") {
    return new ConnectorError(msg, "invalid");
  }
  return new ConnectorError(msg, "upstream");
}

/**
 * Linear reports rate limits as HTTP 400 with a RATELIMITED error, which the
 * shared HttpClient would map to "invalid". This wrapper rewrites such
 * responses to 429 with a Retry-After computed from the reset headers (and
 * auth errors to 401) so HttpClient's own mapping applies. Kept local to this
 * connector rather than changing lib/http.
 */
function linearFetch(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    if (res.ok || res.status === 429 || res.status === 401 || res.status === 403) return res;
    const text = await res.text();
    const err = errorCode(tryJson(text));
    const headers = new Headers(res.headers);
    let status = res.status;
    if (err?.code === "RATELIMITED") {
      status = 429;
      const ms = retryAfterFromReset(res.headers);
      if (!headers.has("retry-after") && ms !== null) headers.set("retry-after", String(Math.ceil(ms / 1000)));
    } else if (err?.code === "AUTHENTICATION_ERROR" || err?.code === "FORBIDDEN") {
      status = 401;
    }
    return new Response(text, { status, statusText: res.statusText, headers });
  }) as typeof fetch;
}

function commentRole(c: z.infer<typeof zComment>, needCommentIds: Set<string>): AuthorRole {
  if (c.externalUser || needCommentIds.has(c.id)) return "requester";
  if (c.botActor) return "bot";
  return "agent";
}

export const linear: ConnectorDefinition<LinearCredentials> = {
  provider: "linear",
  displayName: "Linear",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    {
      key: "apiKey",
      label: "API key",
      secret: true,
      placeholder: "lin_api_…",
      help: "Settings → Security & access → Personal API keys. Needs read and write (comments, issues).",
    },
  ],
  supportsWebhooks: true,
  write: { internalNote: true, publicReply: false, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://linear.app/developers/graphql",
  create(ctx: ConnectorContext<LinearCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const cfg = configSchema.parse(ctx.config ?? {});
    const http = new HttpClient({
      baseUrl: API_URL,
      fetch: linearFetch(ctx.fetch),
      signal: ctx.signal,
      headers: { Authorization: creds.apiKey },
    });

    async function gql<S extends z.ZodType>(
      query: string,
      variables: Record<string, unknown>,
      schema: S,
      what: string,
    ): Promise<z.output<S>> {
      const res = await http.request<unknown>("POST", "", { body: { query, variables } });
      // Partial success (200 with data and errors) is treated as a failure:
      // silently missing history would corrupt the SLA replay.
      const err = errorCode(res.data);
      if (err) throw toConnectorError(err, retryAfterFromReset(res.headers));
      const env = parseAs(zEnvelope, res.data, what);
      return parseAs(schema, env.data, what);
    }

    const mapState = (state: { name: string; type: string }) => {
      const byName = mapStatus(ctx.mapping, state.name);
      if (byName.known) return byName;
      return mapStatus(ctx.mapping, `type:${state.type}`);
    };
    const rawPrio = (p: number | null | undefined) => (p === null || p === undefined ? null : String(p));

    const snapshot = (t: ZIssue): CanonicalTicket => {
      const s = mapState(t.state);
      const rawPriority = rawPrio(t.priority);
      const p = mapPriority(ctx.mapping, rawPriority);
      const issues: MappingIssue[] = [];
      if (!s.known) issues.push({ field: "status", raw: t.state.name });
      if (!p.known && rawPriority !== null) issues.push({ field: "priority", raw: rawPriority });
      const requester = t.asksExternalUserRequester ?? t.externalUserCreator ?? t.asksRequester ?? t.creator ?? null;
      const customer = t.needs.nodes.find((n) => n.customer)?.customer ?? null;
      return {
        ref: { sourceId: t.id, displayKey: t.identifier, url: t.url ?? null },
        subject: t.title,
        status: s.value,
        rawStatus: t.state.name,
        priority: p.value,
        rawPriority,
        requester: {
          sourceId: requester?.id ?? null,
          email: requester?.email ?? null,
          name: requester?.name ?? null,
          orgSourceId: customer?.id ?? null,
          orgName: customer?.name ?? null,
        },
        assignee: t.assignee ? { sourceId: t.assignee.id, name: t.assignee.name ?? null } : null,
        groupSourceId: t.team.id,
        tags: t.labels.nodes.map((l) => l.name),
        channel: t.integrationSourceType ?? null,
        createdAt: parseTime(t.createdAt, "issue.createdAt"),
        updatedAt: parseTime(t.updatedAt, "issue.updatedAt"),
        mappingIssues: issues,
      };
    };

    const teamFilter = () => {
      if (cfg.teamId) return { team: { id: { eq: cfg.teamId } } };
      if (cfg.teamKey) return { team: { key: { eq: cfg.teamKey } } };
      return {};
    };

    return {
      async testConnection() {
        const r = await gql(
          VIEWER_QUERY,
          {},
          z.object({
            viewer: z.object({ id: z.string() }),
            organization: z.object({ id: z.string(), name: z.string() }),
          }),
          "viewer",
        );
        return { accountName: r.organization.name, accountId: r.organization.id };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { after: string } => typeof (v as { after?: unknown })?.after === "string";
        const after = decodeCursor(cursor, isState)?.after ?? null;
        const r = await gql(
          ISSUES_QUERY,
          {
            filter: { updatedAt: { gte: since.toISOString() }, ...teamFilter() },
            first: cfg.pageSize,
            after,
          },
          z.object({ issues: connection(zIssue) }),
          "issues",
        );
        const { hasNextPage, endCursor } = r.issues.pageInfo;
        return {
          items: r.issues.nodes.map(snapshot),
          nextCursor: hasNextPage && endCursor ? encodeCursor({ after: endCursor }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const first = await gql(
          ISSUE_QUERY,
          { id: sourceId },
          z.object({
            organization: z.object({ urlKey: z.string() }),
            issue: zIssue.extend({ history: connection(zHistory), comments: connection(zComment) }),
          }),
          "issue",
        );
        const issue = first.issue;
        const key = (...parts: (string | number)[]) => ["linear", first.organization.urlKey, ...parts].join(":");

        const rest = async <T extends z.ZodType>(
          conn: { nodes: z.output<T>[]; pageInfo: z.infer<typeof zPageInfo> },
          query: string,
          field: "history" | "comments",
          node: T,
        ): Promise<z.output<T>[]> => {
          const more =
            conn.pageInfo.hasNextPage && conn.pageInfo.endCursor
              ? await collectPages<z.output<T>, string>(conn.pageInfo.endCursor, async (after) => {
                  const r = await gql(
                    query,
                    { id: issue.id, after },
                    z.object({ issue: z.object({ [field]: connection(node) }) }),
                    `issue ${field}`,
                  );
                  const c = (r.issue as Record<string, { nodes: z.output<T>[]; pageInfo: z.infer<typeof zPageInfo> }>)[
                    field
                  ];
                  if (!c) throw new ConnectorError(`Linear issue ${field} missing`, "upstream");
                  return {
                    items: c.nodes,
                    next: c.pageInfo.hasNextPage && c.pageInfo.endCursor ? c.pageInfo.endCursor : null,
                  };
                })
              : [];
          return [...conn.nodes, ...more];
        };
        const history = (await rest(issue.history, HISTORY_PAGE_QUERY, "history", zHistory)).sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
        );
        const comments = (await rest(issue.comments, COMMENTS_PAGE_QUERY, "comments", zComment)).sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
        );

        const createdAt = parseTime(issue.createdAt, "issue.createdAt");
        const initialState = history.find((h) => h.fromState)?.fromState ?? issue.state;
        const initialPriority = history.find((h) => h.fromPriority != null && h.toPriority != null)?.fromPriority;
        const events: CanonicalEvent[] = [
          {
            type: "created",
            at: createdAt,
            status: mapState(initialState).value,
            priority: mapPriority(ctx.mapping, rawPrio(initialPriority ?? issue.priority)).value,
            idempotencyKey: key("issue", issue.id, "created"),
          },
        ];

        // The description is the opening message.
        const out: CanonicalComment[] = [];
        if (issue.description?.trim()) {
          const external = issue.externalUserCreator ?? issue.asksExternalUserRequester ?? null;
          const role: AuthorRole = external ? "requester" : issue.botActor ? "bot" : "agent";
          const author = external ?? issue.creator ?? null;
          const sid = `${issue.id}:description`;
          events.push({
            type: "comment",
            at: createdAt,
            author: openingEventAuthor(role),
            public: role === "requester",
            commentSourceId: sid,
            idempotencyKey: key("issue", issue.id, "description"),
          });
          out.push({
            sourceId: sid,
            at: createdAt,
            authorRole: role,
            authorName: author?.name ?? issue.botActor?.name ?? null,
            authorSourceId: author?.id ?? null,
            public: role === "requester",
            bodyText: plainText(issue.description),
          });
        }

        let tagSet: string[] = [];
        for (const h of history) {
          const at = parseTime(h.createdAt, `history ${h.id}`);
          if (h.toState && h.toState.id !== h.fromState?.id) {
            events.push({
              type: "status_changed",
              at,
              status: mapState(h.toState).value,
              rawStatus: h.toState.name,
              idempotencyKey: key("history", h.id, "state"),
            });
          }
          if (h.toPriority != null && h.toPriority !== h.fromPriority) {
            const raw = rawPrio(h.toPriority);
            events.push({
              type: "priority_changed",
              at,
              priority: mapPriority(ctx.mapping, raw).value,
              rawPriority: raw,
              idempotencyKey: key("history", h.id, "priority"),
            });
          }
          if ((h.fromAssigneeId ?? null) !== (h.toAssigneeId ?? null)) {
            events.push({
              type: "assignee_changed",
              at,
              assigneeSourceId: h.toAssigneeId ?? null,
              idempotencyKey: key("history", h.id, "assignee"),
            });
          }
          const added = (h.addedLabels ?? []).map((l) => l.name);
          const removed = new Set((h.removedLabels ?? []).map((l) => l.name));
          if (added.length > 0 || removed.size > 0) {
            tagSet = [...new Set([...tagSet.filter((x) => !removed.has(x)), ...added])];
            events.push({ type: "tags_changed", at, tags: tagSet, idempotencyKey: key("history", h.id, "labels") });
          }
        }

        const needCommentIds = new Set(issue.needs.nodes.flatMap((n) => (n.comment ? [n.comment.id] : [])));
        for (const c of comments) {
          const at = parseTime(c.createdAt, `comment ${c.id}`);
          const role = commentRole(c, needCommentIds);
          const pub = role === "requester";
          events.push({
            type: "comment",
            at,
            // With no description, the first comment is the opening message.
            author: out.length === 0 ? openingEventAuthor(role) : role,
            public: pub,
            commentSourceId: c.id,
            idempotencyKey: key("comment", c.id),
          });
          const author = c.externalUser ?? c.user ?? null;
          out.push({
            sourceId: c.id,
            at,
            authorRole: role,
            authorName: author?.name ?? c.botActor?.name ?? null,
            authorSourceId: author?.id ?? c.botActor?.id ?? null,
            public: pub,
            bodyText: plainText(c.body),
          });
        }

        return { ticket: snapshot(issue), events: dropNoopChanges(finalizeEvents(events)), comments: out };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const ok = verifyHmac({
          algo: "sha256",
          secret,
          payload: req.rawBody,
          signature: header(req.headers, "linear-signature"),
          encoding: "hex",
        });
        if (!ok) return { ok: false, reason: "bad_signature" };
        const parsed = zWebhook.safeParse(tryJson(req.rawBody));
        if (!parsed.success) return { ok: false, reason: "malformed" };
        // Replay protection per Linear's docs: the signed timestamp must be recent.
        if (Math.abs(Date.now() - parsed.data.webhookTimestamp) > WEBHOOK_TOLERANCE_MS) {
          return { ok: false, reason: "bad_signature" };
        }
        const { type, data } = parsed.data;
        const issueId = type === "Issue" ? data.id : data.issueId;
        return { ok: true, ticketSourceIds: issueId ? [issueId] : [] };
      },

      async postInternalNote(sourceId, body) {
        const r = await gql(
          COMMENT_CREATE,
          { input: { issueId: sourceId, body } },
          z.object({
            commentCreate: z.object({ success: z.boolean(), comment: z.object({ id: z.string() }).nullish() }),
          }),
          "commentCreate",
        );
        if (!r.commentCreate.success) throw new ConnectorError("Linear commentCreate failed", "upstream");
        return { commentSourceId: r.commentCreate.comment?.id ?? null };
      },

      async postPublicReply() {
        throw new ConnectorError("Linear is an escalation target: it has no customer-facing replies", "unsupported");
      },

      async updateTicket(sourceId, patch) {
        const input: Record<string, unknown> = {};
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (raw === null || !/^[0-4]$/.test(raw)) {
            throw new ConnectorError(`no Linear priority is mapped to "${patch.priority}"`, "invalid");
          }
          input.priority = Number(raw);
        }
        if (patch.assigneeSourceId !== undefined) input.assigneeId = patch.assigneeSourceId;
        const names = [...new Set(patch.addTags ?? [])];
        if (names.length > 0) {
          const r = await gql(
            ISSUE_LABELS_QUERY,
            { id: sourceId, names },
            z.object({
              issue: z.object({ team: z.object({ id: z.string() }) }),
              issueLabels: z.object({
                nodes: z.array(
                  z.object({ id: z.string(), name: z.string(), team: z.object({ id: z.string() }).nullish() }),
                ),
              }),
            }),
            "issueLabels",
          );
          const teamId = r.issue.team.id;
          input.addedLabelIds = names.map((name) => {
            const candidates = r.issueLabels.nodes.filter((l) => l.name === name);
            const label = candidates.find((l) => l.team?.id === teamId) ?? candidates.find((l) => !l.team) ?? undefined;
            if (!label) throw new ConnectorError(`no Linear label named "${name}" for this issue's team`, "invalid");
            return label.id;
          });
        }
        if (Object.keys(input).length === 0) return;
        const r = await gql(
          ISSUE_UPDATE,
          { id: sourceId, input },
          z.object({ issueUpdate: z.object({ success: z.boolean() }) }),
          "issueUpdate",
        );
        if (!r.issueUpdate.success) throw new ConnectorError("Linear issueUpdate failed", "upstream");
      },
    };
  },
};
