/**
 * GitHub Issues connector (github.com or GitHub Enterprise Server). GitHub is an
 * escalation target (TR-14): one connection watches one repository's issues.
 *
 * API docs (verified 2026-09):
 * - Versions (`X-GitHub-Api-Version`; 2026-03-10 is current, 2022-11-28 the default):
 *   https://docs.github.com/en/rest/about-the-rest-api/api-versions
 * - Breaking changes in 2026-03-10 (singular `assignee` removed; we read `assignees`):
 *   https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
 * - Auth (`Authorization: Bearer <PAT or installation token>`):
 *   https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
 * - List repository issues (state, since, sort, direction; PRs included, marked by `pull_request`)
 *   and Get an issue: https://docs.github.com/en/rest/issues/issues
 * - Timeline events: https://docs.github.com/en/rest/issues/timeline
 * - Event types (labeled/unlabeled/closed/reopened/assigned/unassigned/commented):
 *   https://docs.github.com/en/rest/using-the-rest-api/issue-event-types
 * - Comments: https://docs.github.com/en/rest/issues/comments
 * - Labels (add, remove one): https://docs.github.com/en/rest/issues/labels
 * - Assignees: https://docs.github.com/en/rest/issues/assignees
 * - Pagination (Link header): https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 * - Rate limits (403/429 with retry-after or x-ratelimit-remaining: 0 + x-ratelimit-reset):
 *   https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * - Webhook signatures (`X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`):
 *   https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 * - Webhook payloads (`issues`, `issue_comment`, `ping`):
 *   https://docs.github.com/en/webhooks/webhook-events-and-payloads
 *
 * MODEL — GitHub issues only have open/closed, so:
 * - Status: while open, the first label that is a key of the status mapping
 *   (e.g. "status: waiting-on-customer" → pending) wins; otherwise the raw
 *   status is "open". Closed issues are "closed" (state_reason completed or
 *   none → solved by default), "closed:not_planned" or "closed:duplicate"
 *   (→ closed). Only these open/closed fallbacks can be flagged as unmapped;
 *   arbitrary labels are never flagged as statuses.
 * - Priority: labels that are keys of the priority mapping. With several, the
 *   most urgent wins (the same rule for the snapshot and the history, since the
 *   API's label order says nothing about recency). A priority-looking label that
 *   isn't mapped ("priority: critical", "P4", "sev1") becomes the raw priority
 *   and is flagged.
 * - Tags are the issue's labels.
 * - Authors: `user.type` "Bot" (or a "[bot]" login) → bot; author_association
 *   OWNER/MEMBER/COLLABORATOR → agent; anyone else → requester. The issue body
 *   is the opening message. Every GitHub comment is public: internal notes are
 *   unsupported.
 * - People are identified by login (not numeric id), because the assignees
 *   API takes logins: `assigneeSourceId` is a login.
 *
 * Not verifiable from the docs (needs a real repository to confirm):
 * - `state_reason` on timeline `closed` events is listed in the timeline schema
 *   but not in the event-types page; when absent we fall back to the issue's
 *   current state_reason for the latest close, else "closed".
 * - Labels applied at issue creation are recorded as `labeled` events at the
 *   creation instant; we fold events at exactly created_at into the initial state.
 */
import type { AuthorRole, Priority } from "@slai/sla-engine";
import { z } from "zod";
import { dropNoopChanges, finalizeEvents, openingEventAuthor, parseTime } from "../lib/events.js";
import { header, verifyHmac } from "../lib/hmac.js";
import { detectRateLimits, HttpClient } from "../lib/http.js";
import { mapPriority, mappingIssues, mapStatus, rawPriorityFor } from "../lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor, nextLink } from "../lib/paginate.js";
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
} from "../types.js";

export const GITHUB_API_VERSION = "2026-03-10";
const PAGE_SIZE = 100;

const credentialsSchema = z.object({
  token: z.string().trim().min(1),
  owner: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "The user or organization, e.g. acme-corp"),
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]+$/, "Just the repository name, e.g. helpdesk"),
  apiBaseUrl: z
    .url({ protocol: /^https$/ })
    .default("https://api.github.com")
    .transform((u) => u.replace(/\/+$/, "")),
});
export type GithubCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: {
    open: "open",
    closed: "solved",
    "closed:not_planned": "closed",
    "closed:duplicate": "closed",
    "status: waiting-on-customer": "pending",
    "status: needs-info": "pending",
    "status: on-hold": "on_hold",
    "status: blocked-upstream": "on_hold",
  },
  // rawPriorityFor picks the first key per value, so the "priority: x" labels come first.
  priority: {
    "priority: urgent": "urgent",
    "priority: high": "high",
    "priority: normal": "normal",
    "priority: low": "low",
    P0: "urgent",
    P1: "high",
    P2: "normal",
    P3: "low",
  },
};

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
/** Labels that look like a priority even when the mapping doesn't know them. */
const PRIORITY_LIKE = /^(?:p\d|sev\d|(?:priority|prio|severity|sev)\s*[:/_-])/i;
const AGENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const id = z.union([z.number(), z.string()]).transform(String);
const zUser = z.object({ login: z.string(), id: id.nullish(), type: z.string().nullish() });
type ZUser = z.infer<typeof zUser>;
const zLabel = z.union([z.string().transform((name) => ({ name })), z.object({ name: z.string() })]);
const zIssue = z.object({
  id,
  number: z.number(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  state: z.string(),
  state_reason: z.string().nullish(),
  labels: z.array(zLabel).nullish(),
  assignees: z.array(zUser).nullish(),
  user: zUser.nullish(),
  author_association: z.string().nullish(),
  html_url: z.string().nullish(),
  pull_request: z.unknown().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
type ZIssue = z.infer<typeof zIssue>;

const zTimelineEvent = z
  .object({
    id: id.nullish(),
    event: z.string().nullish(),
    created_at: z.string().nullish(),
    actor: zUser.nullish(),
    user: zUser.nullish(),
    label: z.object({ name: z.string() }).nullish(),
    assignee: zUser.nullish(),
    state_reason: z.string().nullish(),
    body: z.string().nullish(),
    author_association: z.string().nullish(),
  })
  .loose();
type ZTimelineEvent = z.infer<typeof zTimelineEvent>;

const zWebhook = z
  .object({
    issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }).loose(),
    repository: z.object({ full_name: z.string() }).loose().nullish(),
  })
  .loose();

function roleFor(user: ZUser | null | undefined, association: string | null | undefined): AuthorRole {
  if (user?.type === "Bot" || user?.login.endsWith("[bot]")) return "bot";
  return AGENT_ASSOCIATIONS.has((association ?? "").toUpperCase()) ? "agent" : "requester";
}

function closedRaw(stateReason: string | null | undefined): string {
  return stateReason === "not_planned" || stateReason === "duplicate" ? `closed:${stateReason}` : "closed";
}

const isFallbackStatus = (raw: string) => raw.toLowerCase() === "open" || raw.toLowerCase().startsWith("closed");

/** The raw status for an issue state + labels (see MODEL above). */
function deriveRawStatus(mapping: FieldMapping, open: boolean, closed: string, labels: string[]): string {
  if (!open) return closed;
  return labels.find((l) => !isFallbackStatus(l) && mapStatus(mapping, l).known) ?? "open";
}

/** The raw priority label: the most urgent mapped one, else an unmapped priority-looking one. */
function deriveRawPriority(mapping: FieldMapping, labels: string[]): string | null {
  let best: { raw: string; rank: number } | null = null;
  for (const l of labels) {
    const m = mapPriority(mapping, l);
    if (!m.known || m.value === null) continue;
    const rank = PRIORITY_RANK[m.value];
    if (!best || rank < best.rank) best = { raw: l, rank };
  }
  return best?.raw ?? labels.find((l) => PRIORITY_LIKE.test(l)) ?? null;
}

/**
 * GitHub signals rate limits as 403 (primary: x-ratelimit-remaining 0; secondary:
 * retry-after) as well as 429. HttpClient maps 403 to `auth`, so those 403s are
 * rewritten to 429s; HttpClient then reads Retry-After or x-ratelimit-reset.
 */
const rateLimitAware = (f: typeof fetch) =>
  detectRateLimits(f, {
    statuses: [403],
    test: (res) => res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0",
  });

export const github: ConnectorDefinition<GithubCredentials> = {
  provider: "github",
  displayName: "GitHub Issues",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [
    {
      key: "token",
      label: "Access token",
      secret: true,
      help: "Fine-grained PAT or GitHub App installation token with Issues: read and write on the repository",
    },
    { key: "owner", label: "Owner", secret: false, placeholder: "acme-corp", help: "User or organization" },
    { key: "repo", label: "Repository", secret: false, placeholder: "helpdesk" },
    {
      key: "apiBaseUrl",
      label: "API URL",
      secret: false,
      placeholder: "https://api.github.com",
      help: "Only for GitHub Enterprise Server, e.g. https://github.acme.example/api/v3",
    },
  ],
  supportsWebhooks: true,
  webhookSetup: {
    secret: "slai",
    steps: [
      "Repository → Settings → Webhooks → Add webhook, payload URL {url}, content type application/json.",
      "Secret {secret}; events: Issues and Issue comments.",
    ],
  },
  write: { internalNote: false, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://docs.github.com/en/rest/issues",
  create(ctx: ConnectorContext<GithubCredentials>): ConnectorClient {
    const creds = credentialsSchema.parse(ctx.credentials);
    const base = creds.apiBaseUrl;
    const baseOrigin = new URL(base).origin;
    const repoPath = `/repos/${encodeURIComponent(creds.owner)}/${encodeURIComponent(creds.repo)}`;
    const fullName = `${creds.owner}/${creds.repo}`.toLowerCase();
    const http = new HttpClient({
      baseUrl: base,
      fetch: rateLimitAware(ctx.fetch),
      signal: ctx.signal,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
    const key = (...parts: (string | number)[]) => ["github", fullName, ...parts].join(":");

    /** Link-header URLs must stay on the API origin: the token goes with them. */
    const sameOrigin = (url: string) => {
      try {
        return new URL(url).origin === baseOrigin;
      } catch {
        return false;
      }
    };

    const issueNumber = (sourceId: string) => {
      if (!/^\d+$/.test(sourceId)) throw new ConnectorError(`not a GitHub issue number: ${sourceId}`, "invalid");
      return sourceId;
    };

    const snapshot = (t: ZIssue): CanonicalTicket => {
      const labels = (t.labels ?? []).map((l) => l.name);
      const rawStatus = deriveRawStatus(ctx.mapping, t.state === "open", closedRaw(t.state_reason), labels);
      const rawPriority = deriveRawPriority(ctx.mapping, labels);
      const m = mappingIssues(ctx.mapping, rawStatus, rawPriority);
      const assignee = t.assignees?.[0];
      return {
        ref: {
          sourceId: String(t.number),
          displayKey: `${creds.owner}/${creds.repo}#${t.number}`,
          url: t.html_url ?? null,
        },
        subject: t.title ?? "",
        status: m.status,
        rawStatus,
        priority: m.priority,
        rawPriority,
        requester: {
          sourceId: t.user?.login ?? null,
          email: null,
          name: t.user?.login ?? null,
          orgSourceId: null,
          orgName: null,
        },
        assignee: assignee ? { sourceId: assignee.login, name: assignee.login } : null,
        groupSourceId: null,
        tags: labels,
        channel: "github",
        createdAt: parseTime(t.created_at, "issue.created_at"),
        updatedAt: parseTime(t.updated_at, "issue.updated_at"),
        mappingIssues: m.issues,
      };
    };

    const getIssue = async (n: string) => parseAs(zIssue, await http.get(`${repoPath}/issues/${n}`), "issue");

    const buildHistory = (t: ZIssue, timeline: ZTimelineEvent[]) => {
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];
      const createdMs = Date.parse(t.created_at);
      const createdAt = parseTime(t.created_at, "issue.created_at");
      const sorted = timeline
        .filter((e) => e.created_at)
        .map((e, i) => ({ e, i, ms: Date.parse(e.created_at as string) }))
        .sort((a, b) => a.ms - b.ms || a.i - b.i);
      const lastClose = sorted.findLast(({ e }) => e.event === "closed")?.e;

      // Initial labels: the current set, un-applied backwards through label events
      // after creation (events at the creation instant are part of the opening state).
      const labels = (t.labels ?? []).map((l) => l.name);
      for (const { e, ms } of [...sorted].reverse()) {
        if (ms <= createdMs || !e.label) continue;
        const at = labels.indexOf(e.label.name);
        if (e.event === "labeled" && at !== -1) labels.splice(at, 1);
        else if (e.event === "unlabeled" && !labels.includes(e.label.name)) labels.push(e.label.name);
      }
      let open = true;
      let closed = "closed";
      let rawStatus = deriveRawStatus(ctx.mapping, open, closed, labels);
      let rawPriority = deriveRawPriority(ctx.mapping, labels);
      let assignees: string[] = [];

      events.push({
        type: "created",
        at: createdAt,
        status: mapStatus(ctx.mapping, rawStatus).value,
        priority: mapPriority(ctx.mapping, rawPriority).value,
        idempotencyKey: key("issue", t.number, "created"),
      });
      if (labels.length > 0) {
        events.push({
          type: "tags_changed",
          at: createdAt,
          tags: [...labels],
          idempotencyKey: key("issue", t.number, "tags"),
        });
      }
      const openerRole = roleFor(t.user, t.author_association);
      const openingId = `issue-${t.number}`;
      events.push({
        type: "comment",
        at: createdAt,
        author: openingEventAuthor(openerRole),
        public: true,
        commentSourceId: openingId,
        idempotencyKey: key("issue", t.number, "body"),
      });
      comments.push({
        sourceId: openingId,
        at: createdAt,
        authorRole: openerRole,
        authorName: t.user?.login ?? null,
        authorSourceId: t.user?.login ?? null,
        public: true,
        bodyText: plainText(t.body),
      });

      /** Recomputes status/priority after a state or label change and emits what moved. */
      const recompute = (at: Date, k: string, tagsChanged: boolean) => {
        const s = deriveRawStatus(ctx.mapping, open, closed, labels);
        if (s !== rawStatus) {
          rawStatus = s;
          events.push({
            type: "status_changed",
            at,
            status: mapStatus(ctx.mapping, s).value,
            rawStatus: s,
            idempotencyKey: `${k}:status`,
          });
        }
        const p = deriveRawPriority(ctx.mapping, labels);
        if (p !== rawPriority) {
          rawPriority = p;
          events.push({
            type: "priority_changed",
            at,
            priority: mapPriority(ctx.mapping, p).value,
            rawPriority: p,
            idempotencyKey: `${k}:priority`,
          });
        }
        if (tagsChanged) events.push({ type: "tags_changed", at, tags: [...labels], idempotencyKey: `${k}:tags` });
      };

      for (const { e, ms } of sorted) {
        const at = parseTime(e.created_at, `timeline ${e.event} ${e.id ?? ""}`);
        if (e.event === "commented") {
          if (!e.id) continue;
          const role = roleFor(e.user ?? e.actor, e.author_association);
          events.push({
            type: "comment",
            at,
            author: role,
            public: true,
            commentSourceId: e.id,
            idempotencyKey: key("comment", e.id),
          });
          comments.push({
            sourceId: e.id,
            at,
            authorRole: role,
            authorName: (e.user ?? e.actor)?.login ?? null,
            authorSourceId: (e.user ?? e.actor)?.login ?? null,
            public: true,
            bodyText: plainText(e.body),
          });
          continue;
        }
        if (!e.id) continue; // cross-referenced and friends carry no id and no ticket state
        const k = key("event", e.id);
        if ((e.event === "labeled" || e.event === "unlabeled") && e.label) {
          if (ms <= createdMs) continue; // folded into the initial state
          const name = e.label.name;
          const had = labels.includes(name);
          if (e.event === "labeled" && !had) labels.push(name);
          else if (e.event === "unlabeled" && had) labels.splice(labels.indexOf(name), 1);
          else continue;
          recompute(at, k, true);
        } else if (e.event === "closed") {
          open = false;
          closed = closedRaw(e.state_reason ?? (e === lastClose && t.state === "closed" ? t.state_reason : null));
          recompute(at, k, false);
        } else if (e.event === "reopened") {
          open = true;
          recompute(at, k, false);
        } else if ((e.event === "assigned" || e.event === "unassigned") && e.assignee) {
          const before = assignees[0] ?? null;
          const login = e.assignee.login;
          assignees =
            e.event === "assigned"
              ? assignees.includes(login)
                ? assignees
                : [...assignees, login]
              : assignees.filter((a) => a !== login);
          const after = assignees[0] ?? null;
          if (after !== before)
            events.push({ type: "assignee_changed", at, assigneeSourceId: after, idempotencyKey: k });
        }
      }
      return { events: dropNoopChanges(finalizeEvents(events)), comments };
    };

    return {
      async testConnection() {
        const r = parseAs(
          z.object({ id, full_name: z.string(), has_issues: z.boolean().nullish() }),
          await http.get(repoPath),
          "repository",
        );
        if (r.has_issues === false) throw new ConnectorError(`${r.full_name} has issues disabled`, "invalid");
        return { accountName: r.full_name, accountId: r.id };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { u: string } => typeof (v as { u?: unknown })?.u === "string";
        const state = decodeCursor(cursor, isState);
        if (state && !sameOrigin(state.u)) throw new ConnectorError("malformed cursor", "invalid");
        const res = await http.request<unknown>(
          "GET",
          state ? state.u : `${repoPath}/issues`,
          state
            ? {}
            : {
                query: {
                  state: "all",
                  since: since.toISOString(),
                  sort: "updated",
                  direction: "asc",
                  per_page: PAGE_SIZE,
                },
              },
        );
        const data = parseAs(z.array(zIssue), res.data, "issues");
        const next = nextLink(res.headers.get("link"));
        return {
          // The issues endpoint also returns pull requests; they are not tickets.
          items: data
            .filter((t) => t.pull_request === undefined || t.pull_request === null)
            .filter((t) => Date.parse(t.updated_at) >= since.getTime())
            .map(snapshot),
          nextCursor: next && sameOrigin(next) ? encodeCursor({ u: next }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const n = issueNumber(sourceId);
        const issue = await getIssue(n);
        if (issue.pull_request) throw new ConnectorError(`#${n} is a pull request, not an issue`, "not_found");
        const timeline = await collectPages<ZTimelineEvent, string>(
          `${repoPath}/issues/${n}/timeline?per_page=${PAGE_SIZE}`,
          async (url) => {
            const res = await http.request<unknown>("GET", url);
            const items = parseAs(z.array(zTimelineEvent), res.data, "timeline");
            const next = nextLink(res.headers.get("link"));
            return { items, next: next && sameOrigin(next) ? next : null };
          },
        );
        const { events, comments } = buildHistory(issue, timeline);
        return { ticket: snapshot(issue), events, comments };
      },

      async handleWebhook(req, secret) {
        if (!secret) return { ok: false, reason: "bad_signature" };
        const ok = verifyHmac({
          algo: "sha256",
          secret,
          payload: req.rawBody,
          signature: header(req.headers, "x-hub-signature-256"),
          encoding: "hex",
          prefix: "sha256=",
        });
        if (!ok) return { ok: false, reason: "bad_signature" };
        const body = tryJson(req.rawBody);
        if (body === undefined || body === null || typeof body !== "object") return { ok: false, reason: "malformed" };
        const event = header(req.headers, "x-github-event");
        // ping and events we don't subscribe to are acknowledged with nothing to sync.
        if (event !== undefined && event !== "issues" && event !== "issue_comment")
          return { ok: true, ticketSourceIds: [] };
        const parsed = zWebhook.safeParse(body);
        if (!parsed.success) return { ok: false, reason: "malformed" };
        const p = parsed.data;
        // Comments on pull requests arrive as issue_comment with issue.pull_request set.
        if (p.issue.pull_request) return { ok: true, ticketSourceIds: [] };
        // Org-level hooks deliver every repository; only ours matters.
        if (p.repository && p.repository.full_name.toLowerCase() !== fullName) return { ok: true, ticketSourceIds: [] };
        return { ok: true, ticketSourceIds: [String(p.issue.number)] };
      },

      async postInternalNote() {
        throw new ConnectorError(
          "GitHub issue comments are always public; internal notes are unsupported",
          "unsupported",
        );
      },

      async postPublicReply(sourceId, body) {
        const n = issueNumber(sourceId);
        const r = parseAs(z.object({ id }), await http.post(`${repoPath}/issues/${n}/comments`, { body }), "comment");
        return { commentSourceId: r.id };
      },

      async updateTicket(sourceId, patch) {
        const n = issueNumber(sourceId);
        const add: string[] = [];
        const remove: string[] = [];
        if (patch.priority) {
          const raw = rawPriorityFor(ctx.mapping, patch.priority);
          if (!raw) throw new ConnectorError(`no GitHub label is mapped to priority "${patch.priority}"`, "invalid");
          const issue = await getIssue(n);
          for (const { name } of issue.labels ?? []) {
            const m = mapPriority(ctx.mapping, name);
            if (m.known && m.value !== null && name.toLowerCase() !== raw.toLowerCase()) remove.push(name);
          }
          add.push(raw);
        }
        for (const tag of patch.addTags ?? []) if (!add.includes(tag)) add.push(tag);
        if (add.length > 0) await http.post(`${repoPath}/issues/${n}/labels`, { labels: add });
        for (const name of remove) {
          try {
            await http.request("DELETE", `${repoPath}/issues/${n}/labels/${encodeURIComponent(name)}`);
          } catch (err) {
            // Already gone (someone else removed it): the goal state holds.
            if (!(err instanceof ConnectorError && err.kind === "not_found")) throw err;
          }
        }
        // Adds the login alongside any existing assignees (GitHub allows up to 10).
        if (patch.assigneeSourceId !== undefined) {
          await http.post(`${repoPath}/issues/${n}/assignees`, { assignees: [patch.assigneeSourceId] });
        }
      },
    };
  },
};
