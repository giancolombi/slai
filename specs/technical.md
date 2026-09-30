# slai: technical specification

## 1. Architecture

```
            ┌──────────────────────── customer's help desk ─────────────────────────┐
            │ Zendesk · Jira SM · Intercom · Freshdesk · HubSpot · Zammad · ...     │
            └──────────┬───────────────────────────────▲────────────────────────────┘
          webhooks +   │ polling sync                  │ notes / replies / assign
                       ▼                               │
┌────────────┐   ┌───────────────┐   jobs (pg-boss)  ┌─┴──────────────┐    ┌─────────────────┐
│  apps/web  │──▶│   apps/api    │──────────────────▶│  apps/worker   │───▶│  E2B sandboxes  │
│ React SPA  │   │ Hono (REST)   │                   │ sync · eval ·  │    │ one per agent   │
└────────────┘   │ auth · RBAC · │◀──────────────────│ timers · agents│◀───│ run; no DB, no  │
                 │ audit · upload│                   └──────┬─────────┘    │ connector creds │
                 └──────┬────────┘                          │              └─────────────────┘
                        ▼                                   ▼
                 ┌──────────────────────────────────────────────────┐
                 │ PostgreSQL: row-level security per organization  │
                 └──────────────────────────────────────────────────┘
```

| Package | Responsibility | I/O |
|---|---|---|
| `packages/sla-engine` | Calendars, clock math, metric cycles, risk, attainment, credits, next-transition timer | none (pure) |
| `packages/connectors` | Help-desk adapters → canonical tickets and events; webhook verification; write-back | injected `fetch` only |
| `packages/agents` | Contract extraction, triage, drafts; provider routing; metering; guardrails; local and E2B runtimes | model and E2B APIs |
| `packages/db` | Drizzle schema, migrations, RLS, `withOrg`, crypto, job names | Postgres |
| `packages/shared` | API contract: DTOs, zod bodies, route table | none |
| `packages/ui` | slai design system (tokens and components); living style guide at `/design` | none |
| `apps/api` | HTTP API, auth, RBAC, CSRF, audit, uploads, webhook intake, SSE | Postgres, storage |
| `apps/worker` | Sync, ingest, evaluation, timer sweep, agent dispatch, write-back, replay, metering | everything |
| `apps/web` | Product UI; a mock API mode (MSW) for demos | API |
| `sandbox/` | E2B template and the runner executed inside the sandbox | model APIs |
| `deploy/` | Dockerfiles, the service bundler, nginx config for web, Railway config as code (TR-36, TR-40) | none |

### Data flow for one ticket
1. A webhook or the catch-up poll reports that ticket T changed.
2. The worker fetches T's history, maps it to canonical events, and upserts them
   idempotently (keyed by `idempotency_key`).
3. The worker resolves the customer account, then the policy (`decide.ts`), and
   runs `evaluateTicket(policy, events, now)`. It stores the evaluation and each
   cycle's outcome in `sla_outcomes`, and sets `next_check_at = nextTransitionAt(...)`.
4. A sweep every 15s claims tickets past `next_check_at` (`FOR UPDATE SKIP LOCKED`)
   and re-evaluates them.
5. On a risk crossing, `decideDispatch` and `channelsToNotify` decide the outcome:
   notify, run triage and draft in a sandbox, then queue for approval or autopilot
   send (after `decideAutopilot` guardrails). On a ticket's first evaluation only
   a still-actionable crossing counts (TR-21f).
6. Every model call and sandbox second is written to `usage_ledger`. Over the spend
   cap, autonomy degrades to observe.

## 2. Technical requirements

### Stack
- **TR-1** TypeScript (strict, ESM) on Node 24 everywhere, with pnpm workspaces,
  Biome, and vitest. There is no performance penalty for this workload, which is
  I/O-bound on help-desk APIs, model APIs, and sandboxes. The evaluator is a pure
  function, portable to Rust via napi-rs if profiling ever demands it.
- **TR-2** Postgres 18, Drizzle ORM (postgres.js), and **pg-boss** for jobs. Timers
  are a `next_check_at` column plus a sweep, not Temporal, because this keeps one
  less system in SOC 2 scope and keeps timers transactional with their data.
  Revisit if agent work becomes multi-hour and human-in-the-loop.
- **TR-3** API: Hono on `@hono/node-server`. Web: Vite, React 19, TanStack
  Router/Query, Tailwind 4, and Radix primitives.

### SLA engine semantics (PR-11, PR-12, PR-13)
- **TR-4** Metrics:

  | Metric | Starts | Stops | Cycles |
  |---|---|---|---|
  | `first_response` | ticket created | first public agent reply (bot only if `botRepliesCount`), or solve | one |
  | `next_response` | public requester comment after the first response, when none is running | next public agent reply, or solve | many |
  | `periodic_update` | the first response, then each public agent reply, and on reopen | next public agent reply, or solve | many |
  | `resolution` | ticket created | solve/close; a **reopen resumes the same cycle** | one |

- **TR-5** Clocks: `calendar` (24x7) or `business`. Business time counts only the
  weekly hours in the policy's IANA zone, minus holidays, and each local day uses its
  own hours, which makes it DST-safe. A metric pauses while the status is in
  `pauseStatuses[metric]`.
- **TR-6** Priority rules:
  - A running cycle is judged against the current priority, with elapsed time
    carried over.
  - A stopped cycle is frozen at the priority it stopped with.
  - A ticket with no priority uses `defaultPriority`; if that is null too, the
    ticket is not measured.
- **TR-7** Breach timing and risk:
  - **Breach** means elapsed > target, strictly. `breachAt` is the crossing instant.
  - `dueAt` is null while paused.
  - Risk: `warnAt[0]` → warning and `warnAt[1]` → at_risk. The ticket's risk is the
    worst of its metrics.
- **TR-8** Events are ordered by source timestamp; ties keep delivery order.
  Evaluating at `now` ignores later events, which makes replay exact.
- **TR-9** Credits and attainment:
  - Attainment = met / (met + breached) per scope and period.
  - `per_breach` credits accrue per breached cycle.
  - `attainment` credits apply the harshest matching tier.
  - Both can be capped as a % of the period fee.
- **TR-10** Policies are validated with `policySchema`: calendar sanity, no duplicate
  targets, ascending `warnAt`, and solved/closed can never be pause statuses.

### Connectors (PR-6 to PR-9)
- **TR-11** Contract: `packages/connectors/src/types.ts`. Adapters are pure HTTP
  (injected `fetch`, no env, no persistence). They must:
  - honor `Retry-After` by raising `ConnectorError('rate_limited')`
  - reject bad webhook signatures
  - use the shared `lib/http.ts` helpers (T-26): `requestToken` for form-encoded
    OAuth token requests, `detectRateLimits` for vendors that signal limits with
    403/400 (GitHub, Salesforce, Linear), and `retryOnceOnAuth` to refetch a token
    once on a 401
- **TR-11a** OAuth connect and webhook secrets (T-57):
  - A definition may carry `oauth` metadata (authorize/token URL, scopes, PKCE,
    validated user params such as the Zendesk subdomain, and a credentials
    builder). Today: Zendesk, Intercom, HubSpot, Salesforce, Zoho Desk, Help Scout.
  - The API owns the OAuth apps (`OAUTH_<PROVIDER>_CLIENT_ID/SECRET`; redirect URI
    `${API_URL}/api/v1/connections/oauth/<provider>/callback`). `start` needs an
    MFA-complete admin and redirects with a keyring-encrypted state (org, user,
    nonce, PKCE verifier, params, 10-minute expiry) plus an httpOnly SameSite=Lax
    nonce cookie. `callback` rejects a tampered, expired, cross-provider or
    other-browser state and a different user or org, exchanges the code, stores
    the tokens (with the app's client id/secret, for refresh) encrypted, audits
    `connection.created` with `via: oauth`, and redirects to the web app. Tokens
    are never returned or logged.
  - Expiring tokens refresh inside the connector (`lib/oauth.ts` token session);
    rotated credentials go back through `onCredentialsRefreshed`, which the worker
    re-encrypts and stores.
  - `webhookSetup` says who owns the signing secret. `slai`: generated at connect
    and pasted into the help desk. `provider` (Zendesk, Intercom, HubSpot, Front,
    Linear, Zoho): the admin pastes the help desk's secret into slai
    (`PUT /connections/:id/webhook-secret`, audited). The secret never appears in
    list or detail DTOs; `POST /connections/:id/webhook-secret/reveal` is
    admin-only and audited (`connection.webhook_secret_revealed`).
- **TR-12** The canonical status categories are new, open, pending (waiting on the
  requester), on_hold (third party), solved, and closed.
  - Each connector ships a default mapping that the customer can override.
    `connections.mapping` stores only the overrides; the worker layers them over
    the default. `GET/PUT /connections/:id/mapping` (PUT admin-only, zod-validated
    against the canonical values, audited) also reports unmapped and observed raw
    values. A change enqueues `remap-connection`, which re-ingests open tickets and
    closed ones whose raw values now map differently; a re-ingest rewrites a stored
    event's mapped payload under the same idempotency key, so clocks recompute (T-25).
  - The first public agent reply is derived by slai from comments, never trusted
    from the vendor.
- **TR-13** Ingestion:
  - webhook plus an incremental reconciliation poll, with a per-connector
    rate-limit governor
  - stable, source-derived idempotency keys (the same key whether the event arrives
    by webhook or by poll)
  - state transitions derived from history APIs (Zendesk audits, Jira changelog,
    HubSpot property history, etc.)
- **TR-14** Launch-order facts:

  | Platform | Free dev path | Webhooks | Notes |
  |---|---|---|---|
  | Zendesk | Sponsored dev account (partner request) | typed, HMAC-SHA256 | richest SLA data; reference implementation |
  | Jira SM | Free plan and dev site | yes | SLA API needs Standard or a dev license; points-based rate quota |
  | Intercom | Unlimited dev workspaces | yes, HMAC-SHA1 | conversation/ticket split |
  | Freshdesk | Dev trial, extendable | via automation rules (no signature) | free plan has 0 API calls/min |
  | HubSpot | Dev account and test accounts | v3 signature | per-pipeline stage mapping required |
  | Zammad | Self-host in Docker | trigger → webhook | also our SLA conformance fixture |
  | Salesforce | Developer Edition | CDC / Platform Events | External Client Apps since Spring '26 |
  | ServiceNow | Personal dev instance (reclaimed when idle) | outbound REST | `task_sla` |
  | Zoho Desk | Free edition | none on Free (poll) | daily credits |
  | Front, Gorgias, Help Scout, Linear, GitHub | dev account / sandbox / trial | yes | Linear and GitHub are escalation targets |

### Agents (PR-2, PR-3, PR-15 to PR-19)
- **TR-15** Contract: `packages/agents/src/types.ts`. **Agents propose; the worker
  disposes.** Agent code never writes to the DB or the help desk, and every output
  is zod-validated.
- **TR-16** Model routing (prices per million tokens, input/output):

  | Task | Anthropic (primary) | OpenAI (fallback) |
  |---|---|---|
  | triage | `claude-haiku-4-5`, $1/$5 | `gpt-6-luna` |
  | draft | `claude-sonnet-5-5`, $2/$10 | `gpt-6.1-sol` |
  | contract extraction | `claude-opus-5-5`, $4/$20, native PDF | `gpt-6-astra` |

  - Fable 5.1 would be stronger for extraction, but it is not offered under zero
    data retention, so it is not used.
  - Retries use jittered backoff. The fallback is used only for provider errors,
    never for invalid output.
  - A `mock` provider runs everything deterministically with no keys.
- **TR-17** **Commercial API keys only.** Claude Max and ChatGPT/Codex subscriptions
  are consumer plans: they are not licensed to run a multi-tenant product on third
  parties' data, and they can't carry the no-training/DPA/ZDR commitments SOC 2
  customers need.
- **TR-18** Contract extraction:
  - Every citation quote is verified to appear in the document text; unverified
    citations are dropped, and the values they supported become ambiguities.
  - An invalid policy gets one repair round-trip, then fails.
- **TR-19** Prompt-injection hardening:
  - Untrusted text goes only in delimited data blocks, and the system prompt declares
    it data.
  - Output is only ever parsed as schema-validated JSON.
- **TR-20** Autopilot guardrail (`decideAutopilot`, pure) refuses to send when:
  - any draft flag is set, or confidence is below the minimum, or triage says
    `needsHuman`
  - the body is empty or overlong
  - the body contains URLs not present in the thread or knowledge
  - the body matches secret or PII patterns
- **TR-21** E2B runtime:
  - one disposable sandbox per run, from a pinned template build id (never a mutable
    tag)
  - an immutable input manifest with no connector credentials
  - egress allowlisted to the model API hosts
  - the sandbox is always killed (try/finally)
  - hard bounds on wall time, output tokens, and model calls; exceeding one yields
    `bound_exceeded`, never a partial result
  - a concurrency limiter (default 20)

  For local development, `AGENT_RUNTIME=local` runs the same agent code in-process.
- **TR-21a** E2B specifics:
  - Egress: `network.allowOut` is set to the model hosts and `denyOut` to all
    other traffic. Domain filtering only works for HTTP on 80 and TLS on 443.
  - Model keys are injected by the E2B egress proxy using per-host `network.rules`
    header transforms (public beta). The sandbox only ever sees a placeholder key.
  - Residual risk: the raw key lives in E2B's per-sandbox network config, which
    can be read with our E2B API key. The plan is to move to E2B Secrets once
    granted (private beta). The fallback of passing the key as an environment
    variable stays off.
  - Templates are built with the v2 `Template().fromDockerfile()` (v1 CLI builds
    stopped on 2026-08-01) and always referenced as `name:<buildId>`. The runtime
    rejects unpinned references.
  - Cost is recomputed on the host from reported usage, never trusted from the
    sandbox. Known gap: if a run hits its wall-time limit, the model usage inside
    it is lost.

### Worker (T-40 to T-46)
- **TR-21b** Jobs and timers:
  - Queues are the `packages/db` job names; payloads carry ids only. `ingest-ticket`
    (one ticket's history) is fed by `sync-connection` and `process-webhook`.
  - Every 15s the sweep (systemDb, `slai_worker`) claims tickets past `next_check_at`
    with `FOR UPDATE SKIP LOCKED` and leases them (pushes `next_check_at` 2 minutes
    ahead) in the same statement, then enqueues `evaluate-ticket` with a per-ticket
    singleton key. The evaluation sets the real timer. The role holds `UPDATE` on
    `tickets.next_check_at` only.
  - The same tick enqueues `sync-connection` for active connections whose last sync
    is older than 60s (demo) or 5 min (others). Incremental syncs read from the
    stored high-water mark minus a 2-minute overlap and skip unchanged tickets.
  - A `rate_limited` connector error re-enqueues the job after `Retry-After`. An
    `auth` error sets the connection to `error` with `last_error` (audited).
    Unmapped raw values are kept in `connections.mapping_issues`.
  - Time is injected (`clock`) everywhere, including the demo connector.
- **TR-21c** Reactions:
  - The previous-vs-new risk comparison happens under a row lock on the ticket,
    in the evaluation transaction. Alerts go only for open tickets, once per
    crossing per channel. Every delivery is audited (`notification.sent` or
    `notification.failed`).
  - Dispatch creates a queued `draft_reply` run and enqueues `run-agent`. Autonomy
    and spend are checked again when the run starts. Manual runs (`requested_by`
    set) skip the crossing check and run at least at assist.
  - Assist: a proposed `public_reply`, plus an `internal_note` with the triage and
    draft, sent at once when the connector supports notes. Autopilot sends only if
    `decideAutopilot` passes; otherwise the reply is proposed with `blocked_reason`.
    Triage priority and assignee suggestions are always proposals.
  - Every help-desk write is audited as `action.sent` or `action.failed`, with actor
    `agent` or the approving `user`. The ticket is then re-ingested, so slai's own
    reply stops the clock. Each write is claimed first and sent at most once
    (TR-21g).
- **TR-21d** Metering: model calls go to `usage_ledger` as `model_call` rows (tokens,
  micro-dollars), plus `sandbox_seconds` rows. Credits are on the first row of a
  successful run: triage 3, draft 20. An autopilot send adds an `autopilot_reply`
  row at 60. The spend cap compares this month's credits (1 credit = 1 cent) with
  the cap from TR-33 (included + purchased + 50%, or `monthly_spend_cap_cents`
  when the owner set one). Reaching 50/80/100% is recorded once per month
  (`usage.cap_threshold` audit event) and sent to every enabled channel.
- **TR-21e** Breach Replay stores the replayed tickets through the same idempotent
  ingest, but sends no alerts and dispatches no agents. Exposure is
  `computeCredits` per customer per calendar month, using the customer's fee.
  The lead is `breachAt` minus the first at_risk instant, found by stepping the
  engine through event times and `nextTransitionAt`. Policy preview runs inline
  in the API.

- **TR-21f** First-connect guard. A ticket's first evaluation (no stored risk:
  first connect, a full backfill) reacts only to a crossing that is still
  actionable:
  - `actionableRisk` (pure, `decide.ts`) is the worst risk among **live**
    metrics (current cycle not stopped). A stopped cycle's breach is history,
    and a live metric that breached more than the grace window ago
    (`firstSeenGraceMs`, default 60 minutes; per-org later) counts as nothing.
  - Dispatch and every alert channel need the usual crossing **and** a crossing
    on the actionable risk. So a connect with many long-overdue tickets sends no
    alerts and runs no agents for them; a ticket at risk, or breached within the
    window, reacts as usual.
  - From then on the stored risk is the baseline, so a later crossing (a new
    cycle, a re-crossing after recovery) reacts normally. A ticket skipped this
    way stays visible on the dashboard; a human can still run the agents on it.
- **TR-21g** Help-desk writes happen at most once per action, even across
  crashes, pg-boss retries and concurrent jobs (the write and its DB record
  cannot share a transaction):
  - Claim: in one transaction, lock the action, move `approved` → `sending`
    (`sending_at`, a fresh `send_attempt_id`, `send_attempts + 1`), and enqueue a
    reconcile `execute-action` job due `sendReconcileMs` later (default 5 min).
    Only the holder of the current attempt id may record `sent`/`failed`.
  - Outcome of the write: success records `sent`; a clear refusal (`auth`,
    `not_found`, `invalid`, `unsupported`) records `failed`; `rate_limited`
    releases the claim back to `approved` and retries after `Retry-After`.
    Anything else (a crash, timeout, 5xx) is ambiguous: the claim stays.
  - A job that finds a claim younger than the interval does nothing (another
    worker may be mid-write). An older claim is reconciled: fetch the ticket
    with `getTicketWithHistory` and look for our comment (`findSentComment`:
    same visibility, not from the requester, no earlier than `sending_at` minus
    2 minutes of skew, same normalized body or a long truncated prefix of it,
    and not already recorded for another action). Found: record `sent` with
    that comment's id (audited with `reconciled: true`). Absent: take a new
    attempt id and write again. Priority and assignee updates are idempotent,
    so they are simply rewritten.
  - The autopilot send and assist internal note use the same path, so a crash
    after a run's send is finished by the reconcile job, not lost or repeated.
  - Known limit: no connector takes an idempotency key or hidden marker yet, so
    matching is by body within the window.
- **TR-21h** Knowledge sources (T-47). Drafts may only state facts from the
  thread or the knowledge they are given, so the worker gives them the org's
  help-center articles and saved replies:
  - `knowledge_sources` (kind `helpdesk_articles`, `saved_replies` or `manual`;
    status, last sync, last error) and `knowledge_articles` (title, url, plain
    body, locale, `enabled`, and a generated `tsvector`, title weighted above
    body, with a GIN index). Both are org-scoped with forced RLS; `slai_worker`
    sees only the scheduling columns of sources.
  - Connectors with `supportsKnowledge` implement
    `listKnowledgeArticles(cursor)`: Zendesk Help Center, Intercom articles
    (every published locale in `translated_content`), Freshdesk solutions
    (subfolders walked, agents-only folders skipped; every portal language
    from `settings/helpdesk`),
    Zammad knowledge base (public answers only, per locale), HubSpot knowledge
    base (beta API, see below) and the demo help center. Published articles
    only, as bounded plain text. A translation's external id is
    `<id>:<locale>`; the default language keeps the plain id.
  - Freshdesk's API does not expose the portal's custom domain; a connection
    may set `config.portalDomain` (a hostname) and article URLs use it,
    prefixed with `/<lang>` for translations.
  - Connectors with `supportsSavedReplies` implement `listSavedReplies(cursor)`
    (T-47b), returning the same shape (URL null): Zendesk active macros that
    add a public comment (a macro that sets `comment_mode_is_public: false` is
    skipped; unset counts as public, the composer default), Intercom macros
    (API 2.16), Freshdesk canned responses (personal folders skipped), Help
    Scout saved replies per mailbox, Front message templates, Gorgias macros
    with a `setResponseText` action (archived skipped), Zammad text modules
    (inactive skipped) and the demo help desk's macros. Placeholders
    (`{{ticket.requester.first_name}}`, `{% … %}`, `{%customer.firstName%}`,
    `#{ticket.customer.firstname}`) are stripped, not rendered: a declared
    fallback (`fallback: "there"`) is kept, otherwise the placeholder and the
    space before a following comma go ("Hi {{…}}," → "Hi,"). A saved reply is
    knowledge for many tickets, so we never fill in one requester's name.
  - A 403 from a knowledge or saved-reply endpoint (missing scope, role or
    plan) is reported as `unsupported` on the source; it never puts the
    connection in error, since tickets still sync.
  - `sync-knowledge` pages through a source (`listKnowledgeArticles` for
    `helpdesk_articles`, `listSavedReplies` for `saved_replies`) and upserts by
    external id, keeping each article's `enabled` flag, then deletes articles
    the help desk no longer returns. It runs when a connection is created (the
    API adds a `helpdesk_articles` and/or `saved_replies` source, per the
    connector's flags; admins can add either later for a supporting
    connection), on request, and daily from the sweep (sources never synced or
    synced over 24h ago). Rate limits retry; other failures set the source to
    `error`.
  - Retrieval: the subject plus the customer's last public message become an
    any-term `to_tsquery` (letters and digits only, at most 40 terms). The top
    4 enabled articles and saved replies by `ts_rank` are passed as
    `TicketContext.knowledge`, each body cut to 2,500 characters.
  - The draft's `usedKnowledge` indexes are resolved to `{id, title, url}` and
    stored as `usedArticles` on the run output and the reply's payload; the API
    returns them as `AgentAction.usedKnowledge`.
  - The guardrail is unchanged: a URL in the draft must appear in the thread
    or the knowledge. The mock provider quotes and links the most relevant item
    (two shared content words, one in the title), at confidence 0.9; with
    nothing relevant it stays unsure.
  - Platform notes (verified 2026-09): HubSpot's knowledge-base API is beta
    only (`/cms/knowledge-base/2027-03-beta/articles`, Developer Beta Terms,
    Service Hub Professional+, scope `cms.knowledge_base.articles.read`), so
    OAuth asks for that scope as an `optional_scope` and a portal without it
    gets an `unsupported` source error. HubSpot has no saved-replies API.
    Zammad's knowledge base is documented (`POST
    /api/v1/knowledge_bases/init` for the index, one `answers/{id}?include_contents=`
    call per answer for the body); public URLs are
    `/help/<locale>/<category id>-<slug>/<answer id>-<slug>`, a path
    `custom_address` replaces `/help`, and a custom domain gives no URL.
    Help Scout saved replies (and Front templates without `updated_at`) carry
    no update time, so `updatedAt` is the epoch. Other
    connectors (Jira SM, Salesforce, ServiceNow, Zoho Desk, Linear, GitHub)
    have no knowledge sources yet.

### API (PR-24, PR-25)
- **TR-22** The contract is `packages/shared/src/api.ts`: base `/api/v1`, JSON,
  errors as `{error:{code,message}}`, lists as `{items,nextCursor}`, money in cents,
  durations in ms, times as ISO strings. Who-did-it fields (`approvedBy`, `uploadedBy`,
  `decidedBy`) are user ids, each with a `…ByName` display name beside it; a null
  `decidedBy` with `decidedAt` set means slai decided (autopilot or an assist note).
- **TR-22a** Live updates: producers call `notifyEvent` inside their transaction
  (`slai_events`, ids only); `GET /events` forwards only the session org's events.
  Types: `ticket.updated` (ticket, evaluation or one of its agent runs),
  `action.created`, `action.updated` (approved, sending, sent, failed, rejected),
  `replay.progress` (queued, running, progress, done), `contract.updated`. The web
  keeps one EventSource per tab, invalidates the matching query caches (coalesced per
  300 ms), reconnects with jittered backoff (1 s to 30 s) and then refetches all, and
  reconnects on org switch. Polling is only the fallback while the stream is down
  (lists 60 s, in-flight extraction or replay 5 s).
- **TR-22b** Contract text: `GET /contracts/:id/text` extracts on demand with the
  extraction agent's loader (`@slai/agents/documents`: unpdf per PDF page, mammoth for
  DOCX), so pages and quotes match the citations. It returns at most 400k characters
  (`truncated` beyond), is cached per file hash in-process, reads through RLS, and is
  audited as `contract.text_viewed`. The review screen places quotes with the
  extractor's normalization and maps them back to exact offsets.
- **TR-22c** Web bundle: routes are lazy; React, TanStack and zod are separate vendor
  chunks; `@slai/shared` is side-effect free and `API_BASE` lives in its own module, so
  the entry chunk has no zod.
- **TR-23** Auth is **better-auth 1.7** (`better-auth`, with the `twoFactor`
  plugin, `@better-auth/passkey` and `@better-auth/sso`), configured in
  `apps/api/src/auth/better-auth.ts`. slai keeps organizations, memberships,
  roles, RBAC, RLS/`withOrg`, org switching, audit and the MFA gate.
  - **Mounting.** better-auth's handler sits at `/api/v1/auth/*` behind our
    request-id, CSRF, CORS, body-limit and session middleware
    (`auth/handler.ts`). Only an allowlist of endpoints is reachable (sign-in,
    2FA verify/enable/backup codes/disable, passkeys, SSO sign-in/callback/ACS/
    metadata); everything else is 404. Responses are normalized to the
    `@slai/shared` DTOs (`SignInResult`, ...) and `{error:{code,message}}`, and
    never carry a session token. Our own routes: `/auth/signup`, `/auth/discover`,
    `/auth/me`, `/auth/logout`, `/auth/switch-org`.
  - **Storage.** The Drizzle adapter maps better-auth's models onto our tables
    (user → `users`, session → `sessions`, account → `accounts`, verification →
    `verifications`, twoFactor → `two_factors`, passkey → `passkeys`,
    ssoProvider → `sso_providers`) on its own connection as `slai_auth`
    (TR-26). `sealAdapter` wraps the adapter: session tokens are stored only as
    sha256 (`sessions.token_hash`), and SSO client secrets / SAML private keys
    are sealed with our keyring (AES-256-GCM, AAD `sso_provider:<id>:...`).
  - **Passwords** stay argon2id (`@node-rs/argon2`, OWASP parameters) through
    better-auth's custom `hash`/`verify`; migration 0005 turned every
    `users.password_hash` into a `credential` account row. Unknown emails still
    pay a hash (no timing enumeration) and share one generic error.
  - **Sessions.** httpOnly cookie `slai_session` (`__Secure-` prefixed and Secure
    in production), SameSite=Lax, signed with `SESSION_SECRET`; 12h sliding
    idle expiry (refreshed at most once a minute) and a 7-day absolute limit
    checked on `created_at`. Disabled users and users without an org are refused.
    Logout deletes the session server-side. better-auth's cookie cache is off,
    so revocation is immediate.
  - **Mandatory MFA (the gate).** Each session records `auth_method` (password,
    passkey, sso), `mfa_verified` and, for SSO, `sso_org_id`. `mfaState()`
    (`auth/session.ts`) is: passkey sign-in (with user verification) → satisfied;
    SSO in the IdP's own org → satisfied unless that org sets
    `sso_require_mfa`; otherwise the session needs a second factor verified in
    it, else `enrollment_required` (no factor) or `verification_required`.
    `requireAuth()` puts every route outside `/auth` behind it with 403
    `mfa_enrollment_required` / `mfa_required`; better-auth's factor-management
    endpoints need `satisfied` too. Password sign-in for a TOTP user returns
    `mfa_required` with only an httpOnly challenge cookie (no session); for a
    passkey-only user the issued session is revoked and a passkey is required.
    Trusted devices are disabled (every sign-in needs the factor). The last
    factor cannot be removed.
  - **TOTP** is RFC 6238 (SHA-1, 6 digits, 30s, ±1 step). better-auth seals the
    secret and backup codes (XChaCha20-Poly1305 under the versioned
    `SESSION_SECRET`; rotate with `SESSION_SECRET_VERSION` and
    `SESSION_SECRETS_PREVIOUS`). We add replay rejection (a used code is refused
    for 2 minutes) and better-auth locks TOTP for 15 minutes after 10 failures.
    Backup codes are single use (atomic compare-and-swap).
  - **Passkeys**: WebAuthn with rpID = the web app's host, origin = APP_URL,
    user verification required at registration and checked at authentication.
  - **SSO**: OIDC (discovery at registration, PKCE, ID token verified against the
    IdP's JWKS) and SAML (metadata URL or XML; IdP-initiated flows off). Providers
    are written by `/org/sso/*` (admin/owner, audited), not better-auth's register
    endpoint. IdP URLs must be https on a public host unless the operator
    allowlists an internal IdP origin in `SSO_TRUSTED_IDP_ORIGINS`. Domain
    ownership: a TXT record `_slai-verification.<domain>` =
    `slai-verification=<token>` (DNS resolver injected for tests); a domain
    verified by one org cannot be claimed by another. Sign-in resolves the
    provider from the email's verified domain; JIT (`provisionUser`) adds the user
    to the provider's org as `member`, and a new user must have an email on that
    provider's verified domains. `enforce_sso` (needs a verified provider; lifted
    when the last one is deleted) refuses password and passkey sign-in and
    signup for those domains with 403 `sso_required`.
  - **Rate limits**: our token buckets (per IP and per email on password sign-in,
    per IP on 2FA verification, passkey and SSO starts, discovery and signup).
    better-auth's built-in limiter is off (it is per-instance memory, like ours,
    but cannot key by email).
  - **Audit**: `auth.login` (method, second factor), `auth.login_failed` (reason),
    `auth.password_verified`, `auth.login_rate_limited`, `auth.logout`,
    `auth.mfa_setup_started`, `auth.mfa_enabled`, `auth.mfa_verified`,
    `auth.mfa_failed`, `auth.mfa_disabled`, `auth.backup_code_used`,
    `auth.backup_codes_regenerated`, `auth.passkey_added`, `auth.passkey_removed`,
    `sso.provider_created|updated|deleted`, `sso.domain_verified`,
    `sso.domain_verification_failed`, `sso.enforcement_enabled|disabled`,
    `sso.mfa_policy_changed`, `sso.jit_provisioned`.
  - **Demo**: `demo@slai.dev` is pre-enrolled in TOTP with a fixed, dev-only
    secret printed by the seed; `pnpm demo:otp` prints the current code. No demo
    SSO provider is seeded (there is no local mock IdP in docker compose; the
    tests use `oauth2-mock-server`).
- **TR-23a** SOC 2 note on SSO and MFA (decision): an SSO session satisfies
  slai's MFA requirement through the IdP by default, because the customer's IdP
  is where their MFA policy (factors, device posture, conditional access) is
  enforced and audited, and requiring a second slai factor on top adds friction
  without closing a gap the IdP leaves open. The trust is scoped: it applies only
  in the org that owns the IdP (after switching to another org the session must
  pass slai MFA), and each org can turn on "also require slai MFA for SSO users"
  when its IdP does not enforce MFA. slai does not inspect the IdP's `amr`/`acr`
  claims yet; customers attest that their IdP requires MFA during onboarding.
- **TR-24** CSRF defense: SameSite=Lax, an Origin check, a Sec-Fetch-Site check and
  `X-Requested-With: slai` on mutations, including better-auth's endpoints (our
  middleware runs before its handler). Exempt: signature-verified webhooks and the
  SAML ACS (a cross-site POST from the IdP, verified by the assertion signature
  and InResponseTo). RBAC comes from the membership role.
- **TR-24a** Client IPs and rate limits behind proxies (T-63):
  - `TRUST_PROXY` is `false` (socket address), a hop count (`true` = 1), or the
    proxies' CIDRs. X-Forwarded-For is read **from the right**: the client is the
    first address that is not one of our proxies; the left end is client-supplied
    and never believed (`apps/api/src/client-ip.ts`).
  - The login, signup and webhook limits are in-memory token buckets, **per
    process**: with N API replicas a client gets N times the budget. Before running
    more than one replica set `RATE_LIMIT_STORE=postgres`: every POST under `/auth`
    (per IP) and every webhook delivery (per connection) then also draws from a
    shared bucket in the unlogged `rate_limit_buckets` table (one atomic upsert per
    request). The per-email login limit stays per process.
- **TR-25** Uploads are checked by magic bytes (not extension) and sha256-hashed,
  behind a storage-driver interface: `local` (development) or `s3` (TR-25a).
- **TR-25a** The `s3` driver (`packages/db/src/storage.ts`) speaks the S3 API, so it
  covers AWS S3, GCS (XML API interop with HMAC keys), Cloudflare R2, Railway
  buckets and MinIO. Objects carry Content-Type and a `sha256` metadata field;
  puts are write-once (`If-None-Match: *`, `S3_WRITE_ONCE=false` where a provider
  lacks it). Server-side encryption: `S3_SSE=AES256` (SSE-S3), `aws:kms` with
  `S3_SSE_KMS_KEY_ID`, or `provider` for stores that always encrypt at rest and
  reject the AWS header (GCS, R2, Railway). On AWS leave the access keys unset
  and the SDK uses the task/pod role. Buckets: private, versioned where supported,
  with a lifecycle rule expiring noncurrent versions after 30 days (so a delete is
  final within 30 days); created by infrastructure, not the app.

### Security and SOC 2 (PR-26)
- **TR-26** Tenant isolation lives in Postgres:
  - `org_id` plus an RLS policy on every org-scoped table, with FORCE RLS
  - the app role is `slai_app` (NOBYPASSRLS)
  - all org queries go through `withOrg`, which sets `app.org_id` per transaction
  - the auth role is `slai_auth` (DATABASE_AUTH_URL): better-auth's connection and
    the only role that can read password hashes, TOTP secrets, sessions,
    passkeys, verifications and SSO configs. It bypasses RLS (sign-in resolves
    users, memberships and SSO domains before an org is known) but is granted
    only the identity tables plus INSERT on organizations, memberships (signup,
    JIT) and audit_events; it cannot read ticket content, credentials or policies.
    `slai_worker` no longer touches sessions or writes users.
  - `sso_providers` is org-scoped (FORCE RLS); `slai_app` may read its own org's
    providers (the client secret there is ciphertext) but not write them.
- **TR-27** Secrets (connector credentials, SSO client secrets and SAML keys, Slack
  webhooks) use AES-256-GCM with a key id, so keys can rotate. TOTP secrets,
  backup codes and IdP OAuth tokens are sealed by better-auth under the versioned
  `SESSION_SECRET` (TR-23). They are never logged, never
  returned by the API, and never passed into a sandbox.
- **TR-27a** Key rotation (`ENCRYPTION_KEY` keyring). Yearly, and at once after
  suspected exposure or when someone with access leaves:
  1. Generate a key (`openssl rand -base64 32`) and store it in the secrets manager.
  2. Deploy API and worker with `ENCRYPTION_KEY=<new>`, `ENCRYPTION_KEY_ID=<new id>`,
     `ENCRYPTION_KEYS_PREVIOUS=<old id>:<old key>`. New writes use the new key;
     reads find the key named in each ciphertext.
  3. `pnpm keys:rotate --dry-run`, then `pnpm keys:rotate` (owner role;
     `DATABASE_URL` and `DATABASE_SYSTEM_URL`). It re-encrypts every column in
     `SECRET_COLUMNS` (connection credentials and webhook secrets, Slack
     webhooks, SSO client secrets and SAML keys) org by org, in batches, with the
     same AAD, and reports what is left on each old key id. Unreadable values are
     counted and left untouched, never logged.
  4. When nothing is left, remove the old key from `ENCRYPTION_KEYS_PREVIOUS`,
     redeploy, and destroy it. Record the rotation in the access-review log (TR-44).
  `SESSION_SECRET` rotates the same way through `SESSION_SECRET_VERSION` and
  `SESSION_SECRETS_PREVIOUS` (TR-23); better-auth re-seals on write.
- **TR-28** `audit_events` is append-only: a trigger rejects UPDATE and DELETE. It
  covers auth, membership, connections, policy approvals, autonomy changes, action
  approvals, and every help-desk write.
- **TR-29** Logs are structured (pino), with secrets, cookies, and authorization
  headers redacted. Every request carries an id. Security headers are set.
- **TR-30** Every model call and sandbox second is metered to `usage_ledger`:
  provider, model, tokens including cache, cost in micro-dollars, and sandbox
  seconds.
- **TR-30a** SOC 2 control mapping (what enforces each control in code):

  | Control | Enforced by |
  |---|---|
  | CC6.1 Tenant isolation | FORCE RLS on every org table; `withOrg`; `slai_app` NOBYPASSRLS; `assertInOrg` on client-supplied ids (foreign-key checks skip RLS) |
  | CC6.1 Least privilege | Separate roles: only `slai_auth` can read password hashes, TOTP secrets, sessions, passkeys and SSO configs, and it cannot read org data; `slai_app` has no grant on them; `slai_worker` cannot read ticket content, credentials, or policies |
  | CC6.1 Authentication and MFA | better-auth; argon2id; a hash for unknown emails and one generic error; **mandatory MFA** enforced server-side by `requireAuth` (403 `mfa_enrollment_required` / `mfa_required`) for every route outside `/auth`; TOTP with replay rejection and lockout, single-use backup codes, WebAuthn passkeys with user verification; no trusted devices; the last factor cannot be removed |
  | CC6.1 SSO | OIDC/SAML per org; DNS-verified domains; JIT as `member` only on verified domains; enforce-SSO disables password and passkey sign-in; IdP MFA trusted only in the IdP's org and only while the org has not turned on "also require slai MFA" (TR-23a) |
  | CC6.1 Sessions | sha256-only token storage (sealing adapter); signed httpOnly cookie; 12h idle / 7d absolute; a new session on sign-in and on enrollment; server-side logout |
  | CC6.3 RBAC | `requireRole`; the last owner is protected; membership is rechecked on every request |
  | CC6.6 Boundary | CSRF (header + Origin + Sec-Fetch-Site) on every mutation including better-auth's; an allowlist of better-auth endpoints; CORS locked to `APP_URL`; body limits; sign-in, 2FA, passkey and webhook rate limits; webhook signatures; IdP URLs must be public https unless allowlisted |
  | CC6.7 Encryption at rest | AES-256-GCM with a key id and context-bound AAD for every secret (SSO client secrets included); better-auth's versioned XChaCha20-Poly1305 for TOTP secrets, backup codes and IdP tokens; secrets masked or write-only in the API |
  | CC6.8 Uploads | Magic-byte sniffing; 20 MB cap; sanitized names; server-generated storage keys |
  | CC7.2 Audit and logs | `audit()` in the same transaction; a trigger blocks UPDATE/DELETE/TRUNCATE; pino redaction; no request bodies in logs |
  | CC8.1 Change integrity | Policies need `parsePolicy` and admin approval; versions are superseded, never edited in place |
  | PI1 Billing integrity | Append-only `usage_ledger` and `credit_grants`; money figures come only from the engine; plans and billing rules are pure code (`plans.ts`); Stripe webhooks signature-verified and applied once per event (`billing_events`); overage reported once per closed month |
  | CC6.7 Encryption in transit | Production guard (TR-37): https URLs, `sslmode` on every database URL, SMTP over TLS, https object storage; HSTS on web and API |
  | CC6.1 Key management | Keyring with key ids; `pnpm keys:rotate` re-encrypts under the new key (TR-27a) |
  | CC6.8 Supply chain | Images built in CI; Trivy fails the build on critical findings in images and the lockfile; CycloneDX SBOMs; BuildKit provenance on pushed images (TR-39) |
  | CC7.4 Incident response | TR-43; audit trail survives org deletion |
  | A1.2 Backups and recovery | Managed PITR plus nightly `db:backup --upload` with grandfather retention; restore tested in CI (TR-38) |
  | C1.2 / P4.3 Retention and disposal | Hourly retention job; export and scheduled, cancellable, audited org deletion that removes stored files (TR-30b, TR-30c) |
  | CC6.1 Access reviews | Quarterly procedure over members, owners, roles and infrastructure access (TR-44) |

- **TR-30b** Retention (T-64). The worker's hourly `run-retention` job (a pg-boss
  singleton, so one run at a time across workers; `apps/worker/src/retention.ts`):

  | Data | Kept | Then |
  |---|---|---|
  | Ticket comment bodies, agent run outputs, finished action bodies | `RETENTION_CONTENT_DAYS` (400) | blanked (`ticket_comments.redacted_at`); tickets, events and `sla_outcomes` stay, so attainment and credits are unchanged |
  | Archived contracts (row and file) | `RETENTION_ARCHIVED_CONTRACT_DAYS` (30) after `archived_at` | hard-deleted (file first), audited `contract.purged` |
  | Export bundles | 7 days | file and row deleted |
  | Expired sessions, verification tokens, unaccepted expired invitations, idle rate-limit buckets | until expiry | deleted (`slai_purge_expired_auth()` checks which auth tables exist) |
  | `audit_events`, `usage_ledger`, `credit_grants` | **at least 1 year**; never deleted by any job | append-only (trigger); no foreign key to `organizations`, so they survive an org delete. Pruning older rows is a manual, owner-role procedure after the retention commitment |

  Each purge is audited per org (`retention.purged` with counts). Knowledge
  articles live as long as their source.
- **TR-30c** Org offboarding (owner only; `apps/api/src/routes/offboarding.ts`,
  `apps/worker/src/offboarding.ts`, Settings → Organization):
  - Export: `POST /org/exports` queues `export-org`, which writes a tar.gz to
    storage: `manifest.json`, `data/<table>.json` for every org table, and each
    contract file. Secrets are excluded (credentials, webhook secrets, Slack
    URLs, SSO configs, tokens). One export at a time; download for 7 days;
    requested, completed and downloaded are audited. The bundle is built in
    memory: fine to a few hundred MB; stream it (multipart upload) before
    orgs outgrow that.
  - Delete: `POST /org/deletion` (typing the org name) schedules a hard delete 7
    days out and enqueues `delete-org` for then; any owner can cancel
    (`DELETE /org/deletion`). Scheduled and cancelled are audited. When due, the
    worker deletes the org's files, then calls `slai_delete_org(id)`, a SECURITY
    DEFINER function that deletes only if `deletion_scheduled_for <= now()` by
    the database clock (so neither a wrong worker clock nor a retried job can
    delete early or after a cancel); every org table cascades. `org.deleted`
    is audited by the system role. User accounts are kept (they may belong to
    other orgs).
- **TR-31** CI (lint, typecheck, test against Postgres and MinIO) must pass before
  merging to main. The Images workflow (TR-39) must pass too.

### Billing (PR-23, T-65)
- **TR-33** Plans, entitlements and credits are pure code in
  `packages/shared/src/plans.ts` (`PLANS`, `TRIAL`, `entitlements`,
  `creditBalance`, `cycleLiveIn`, `mapStripeStatus`); `packages/db/src/billing.ts`
  only loads their inputs inside `withOrg`.
  - Stored on `organizations`: `plan`, `billing_status` (`trialing | active |
    past_due | canceled`), `trial_ends_at` (a column default of now + 14 days, so
    every signup path starts the trial with no hook), `past_due_since`,
    `stripe_customer_id`, `stripe_subscription_id`.
  - `entitlements(org, now)` derives the state (`trialing`, `trial_expired`,
    `active`, `past_due` within 7 days, `degraded` after, `canceled`), the agent
    ceiling (`observe < triage < assist < autopilot`), included credits and
    whether overage is billed.
  - The worker enforces the ceiling in `decideDispatch` and again when a run
    starts (`decideRunLevel`): the rule's level is capped at the ceiling (a
    triage ceiling queues a triage run only, and refuses a draft; manual runs
    are capped too). Over the spend cap, agents observe. Alerts, evaluation and
    the timer sweep never read billing state.
  - Credits: `creditBalance` draws included, then purchased (`credit_grants`,
    append-only; available = grants − what earlier periods drew), then overage.
    `spendState(usedCredits, capCredits)` compares against the cap.
- **TR-34** Periods and metering. The billing period is the UTC calendar month
  (the same as the spend cap).
  - Tracked tickets = distinct tickets in `sla_outcomes` with a cycle live in
    the period (`started_at < end and (stopped_at is null or stopped_at >= start)`).
  - The `billing-snapshot` job (scheduled per org, hourly, by the sweep; ids
    only across orgs) upserts the month's row in `billing_periods` (tracked,
    limit, overage, credits used/included/purchased/overage, billable cents),
    closes the previous month once, and sends owner emails once each (audit-event
    keys): tracked overage per month, trial ending (≤ 3 days), trial ended,
    degraded after a failed payment.
  - A closed month's billable overage is reported to Stripe **Billing Meter
    events** (`billing.meterEvents.create`; legacy usage records are gone since
    2025-03-31.basil): `slai_tracked_ticket_overage` (tickets) and
    `slai_credit_overage` (credits), keyed `orgId:YYYY-MM:kind` (Stripe dedupes
    identifiers), timestamped inside the month, then marked `reported_at`.
    Subscriptions are anchored to the 1st of the month so Stripe's periods match.
- **TR-35** Stripe (official `stripe` SDK, API version pinned by the SDK).
  Keys come from env (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids per
  plan and per overage meter). Without a secret key, billing runs in **manual
  mode**: plans come from the seed (the demo org is Scale, active) or
  `POST /billing/manual` (owner/admin; refused in production); nothing is
  reported.
  - Checkout (subscription mode, plan price + both metered prices), the
    Customer Portal (payment methods, invoices; an existing subscription changes
    plan through the portal's `subscription_update` flow), and credit packs
    (payment mode, inline price data from `CREDIT_PACKS`). One Stripe customer
    per org (created on first use with an idempotency key; audited).
  - `POST /billing/webhook` is public and CSRF-exempt; the `Stripe-Signature` is
    verified over the raw body (bad, stale or missing → 400). The org is found by
    the stored customer id, else our org id in the event metadata. Each event id
    is claimed in `billing_events` in the same transaction that applies it, so a
    redelivery is a no-op; a credit pack grants once per Checkout Session
    (unique session id) and only when paid, with credits from the pack
    definition, never from metadata. Handled: `checkout.session.completed`,
    `customer.subscription.created/updated/deleted` (plan from the price id; an
    old subscription's deletion never cancels the current one),
    `invoice.paid` (past due → active) and `invoice.payment_failed` (→ past due,
    keeping the first failure time). Every applied event is audited
    (`billing.<type>` with from/to).

### Deployment and operations (T-63, T-64)
- **TR-36** Images (`deploy/docker/*.Dockerfile`, built from the repo root). Any
  container platform runs them; nothing is provider-specific.

  | Image | Runs | Port / health |
  |---|---|---|
  | `slai-api` | `node dist/api.mjs`; also `node dist/migrate.mjs`, `seed.mjs`, `keys-rotate.mjs` (the `migrate` target is the same image) | 8787 (`$PORT`), `/readyz` |
  | `slai-worker` | `node dist/worker.mjs`; not public | `/healthz` on `$HEALTH_PORT`, else `$PORT`, else 8788 (sweep liveness) |
  | `slai-web` | unprivileged nginx: the Vite build, SPA fallback, `/assets` cached immutable, `index.html` no-cache, `/api` proxied to `API_UPSTREAM` | 8080 (`$PORT`), `/healthz` |
  | `slai-backup` | `node dist/backup.mjs --upload` with pg_dump 18 | one-shot / cron |

  - Multi-stage: `pnpm fetch` + offline install, then esbuild bundles each service
    (`deploy/bundle.mjs`) so the runtime holds only node, the bundle and the
    argon2 native addon. npm, corepack and yarn are removed; OS packages upgraded.
  - Non-root; files owned by root, so the root filesystem can be read-only
    (writes go to `/tmp` only); no capabilities needed.
  - The web CSP: scripts from self only (the theme bootstrap is `/theme-init.js`,
    not inline), styles self + `'unsafe-inline'` (Radix style tags) + Google Fonts,
    fonts from gstatic, `connect-src 'self'` (the API is same-origin through the
    proxy), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; plus
    HSTS, nosniff, DENY framing, COOP/CORP and a restrictive Permissions-Policy.
    Source maps and the MSW worker are not shipped.
  - Migrations run exactly once per release, before new code serves traffic, as
    the owner role (`DATABASE_URL`). A Postgres advisory lock serializes
    concurrent runners. With `MIGRATE_SET_ROLE_PASSWORDS=true` the migrate job sets
    `slai_app`, `slai_worker` and `slai_auth` passwords from their runtime URLs,
    so the development passwords in the migrations never survive a deploy.
  - `docker-compose.prod.yml` runs the stack from the images (Postgres, MinIO,
    Mailpit, migrate, api, worker, web; `seed` and `backup` profiles) hardened as
    in production (read-only, `cap_drop: [ALL]`, `no-new-privileges`), with
    `DEPLOY_ENV=staging`.
- **TR-37** Production guard (`packages/db/src/prod-env.ts`). With
  `DEPLOY_ENV=production` (or `NODE_ENV=production` and no `DEPLOY_ENV`) the api,
  worker and migrate refuse to start, listing every problem by name, when:
  `MODEL_PROVIDER=mock`, `AGENT_RUNTIME` is not `e2b` or `E2B_TEMPLATE` is not
  pinned, a provider key is missing, `STORAGE_DRIVER` is not `s3` or `S3_SSE` is
  unset, `APP_URL`/`API_URL`/`S3_ENDPOINT` are not https, a database URL has no
  `sslmode=require|verify-ca|verify-full` (a Unix-socket host is exempt), SMTP is
  not TLS (`smtps://` or `requireTLS=true`), a role password is a development
  default (`slai`, `slai_app`, `slai_worker`, `slai_auth`, …) or equals the role
  name, or `ENCRYPTION_KEY` equals `SESSION_SECRET`. `DEPLOY_ENV=staging` runs a
  production build with mocks allowed.
- **TR-38** Backups and disaster recovery.
  - Primary: the managed database's automated backups with point-in-time
    recovery, retained at least 14 days (RPO minutes).
  - Secondary, provider-independent: `pnpm db:backup` (pg_dump custom format,
    `--no-owner`, with a `.sha256`) run nightly by the `slai-backup` image with
    `--upload` to a separate bucket (`BACKUP_S3_BUCKET`, versioned/immutable where
    the provider allows). Retention: every backup for 35 days, then the first of
    each month for 12 months (`BACKUP_KEEP_DAILY_DAYS`,
    `BACKUP_KEEP_MONTHLY_MONTHS`); pruned by the same job. Backups hold customer
    data: encrypted at rest, access limited to the owner role's operators.
  - Restore: `pnpm db:restore <file> [--target <url>] [--clean]` verifies the
    checksum, creates the runtime roles if missing (NOLOGIN), restores in one
    transaction, and refuses a non-empty target without `--clean`. Then set role
    passwords (`migrate` with `MIGRATE_SET_ROLE_PASSWORDS=true`, which also
    confirms the schema is current) and point the services at it.
  - pg_dump must match the server's major version: the tools run locally when new
    enough, otherwise from `postgres:<major>` (`PG_TOOLS=local|docker`).
  - Tested: `packages/db/test/backup.test.ts` round-trips a database (data, RLS,
    grants, the append-only trigger). Restore drill quarterly into a scratch
    database; RTO target 2 hours. Object storage (contracts) is covered by bucket
    versioning, not by the dump.
- **TR-39** CI for images (`.github/workflows/images.yml`): every PR builds the
  four images and scans them with Trivy (critical findings fail); because the
  services are bundled, `pnpm-lock.yaml` is scanned too. CycloneDX SBOMs (source
  and each image) are uploaded as artifacts. On `main` the images are pushed to
  `ghcr.io/giancolombi/slai-{api,worker,web,backup}` (tags `sha-<short>` and `main`)
  with `GITHUB_TOKEN`, carrying BuildKit SBOM and provenance attestations.
- **TR-40** Deploying to Railway (the chosen initial host). Deploy-ready; not yet
  deployed (T-67). Config as code: `deploy/railway/{api,worker,web,backup}.json`
  (each service's "Config file" setting points at its file). Railway is SOC 2 Type
  II (trust.railway.com).
  - Services: `Postgres` (Railway's template: the official image with SSL; its
    `postgres` user is a superuser, so the migrations' `CREATE ROLE` works), a
    `Bucket` for contracts and one for backups, `api` (public domain; pre-deploy
    command `node dist/migrate.mjs`, run once per deploy in its own container),
    `worker` (no public domain), `web` (public domain), `backup` (cron
    `17 3 * * *`).
  - Networking: the browser only talks to `web`, which proxies `/api` to the api's
    public HTTPS domain (`API_UPSTREAM`), so cookies are host-only on the web
    domain, CORS/CSRF see `Origin = APP_URL`, and no cookie domain is set.
    `API_URL` is the api's own domain (webhooks and SSO callbacks go there
    directly). Postgres is reached over the private network
    (`postgres.railway.internal`, WireGuard-encrypted) with `sslmode=require`
    (Railway's certificate is self-signed, so not `verify-full`). Buckets are
    public-endpoint only (https).
  - `TRUST_PROXY`: Railway's edge appends to X-Forwarded-For, and UI traffic
    passes web → edge → api. Use CIDRs: Railway's private ranges plus the
    project's static egress IPs (`TRUST_PROXY=10.0.0.0/8,100.64.0.0/10,fd00::/8,<egress
    IPs>`), then confirm real client IPs in the audit log after the first deploy.
    Alternative: `API_UPSTREAM=http://api.railway.internal:8787` (private network)
    and only the private ranges.
  - Variables (`${{…}}` are Railway reference variables; **generate** = create
    once with `openssl rand -base64 32`, or `openssl rand -hex 24` for
    passwords, and store as a shared variable):

    | Variable | api | worker | web | backup | Value |
    |---|---|---|---|---|---|
    | `NODE_ENV`, `DEPLOY_ENV` | ✓ | ✓ | | ✓ | `production` |
    | `APP_URL` | ✓ | ✓ | | | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` (or the custom domain) |
    | `API_URL` | ✓ | | | | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` |
    | `DATABASE_URL` (owner; migrations, backups) | ✓ | | | ✓ | `${{Postgres.DATABASE_URL}}?sslmode=require` |
    | `DATABASE_APP_URL` | ✓ | ✓ | | | `postgres://slai_app:${{shared.SLAI_APP_DB_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}?sslmode=require` |
    | `DATABASE_SYSTEM_URL` | ✓ | ✓ | | | same with `slai_worker` / `SLAI_WORKER_DB_PASSWORD` |
    | `DATABASE_AUTH_URL` | ✓ | | | | same with `slai_auth` / `SLAI_AUTH_DB_PASSWORD` |
    | `SLAI_*_DB_PASSWORD` | shared | | | | generate |
    | `MIGRATE_SET_ROLE_PASSWORDS` | ✓ | | | | `true` |
    | `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID` | ✓ | ✓ | | | generate; `k1` |
    | `SESSION_SECRET` | ✓ | | | | generate (different from `ENCRYPTION_KEY`) |
    | `STORAGE_DRIVER` | ✓ | ✓ | | | `s3` |
    | `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | ✓ | ✓ | | ✓ | `${{Bucket.BUCKET}}`, `${{Bucket.ENDPOINT}}`, `${{Bucket.REGION}}`, `${{Bucket.ACCESS_KEY_ID}}`, `${{Bucket.SECRET_ACCESS_KEY}}` |
    | `S3_SSE`, `S3_WRITE_ONCE`, `S3_FORCE_PATH_STYLE` | ✓ | ✓ | | ✓ | `provider` (buckets encrypt at rest; no SSE header, versioning or lifecycle), `false` (conditional puts are not documented), `false` (virtual-hosted URLs) |
    | `BACKUP_S3_BUCKET` | | | | ✓ | `${{Backups.BUCKET}}` (and that bucket's keys in the `S3_*` above) |
    | `TRUST_PROXY`, `RATE_LIMIT_STORE` | ✓ | | | | see above; `postgres` |
    | `SMTP_URL`, `EMAIL_FROM` | | ✓ | | | the email provider, `smtps://…` |
    | `MODEL_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | | ✓ | | | `anthropic`; commercial keys |
    | `AGENT_RUNTIME`, `E2B_API_KEY`, `E2B_TEMPLATE` | | ✓ | | | `e2b`; the pinned `slai-agent:<buildId>` |
    | `API_UPSTREAM` | | | ✓ | | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` |
    | `STRIPE_*`, `OAUTH_*`, `SSO_TRUSTED_IDP_ORIGINS` | ✓ | as needed | | | from the providers |

    `PORT` is injected by Railway; the images honor it.
  - CLI (from the repo root, logged in with `railway login`):
    ```
    railway init --name slai                 # or: railway link (existing project)
    railway add --database postgres
    railway add --service api                # repeat for worker, web, backup
    # Dashboard: Create → Bucket, twice ("Bucket", "Backups"); per service,
    # Settings → Config file = /deploy/railway/<service>.json and connect the GitHub repo.
    railway variables --service api --set "NODE_ENV=production" --set "DEPLOY_ENV=production" …
    railway domain --service web             # and --service api (webhooks, SSO callbacks)
    railway up --service api                 # first deploy from the working tree; then deploys follow main
    railway up --service worker && railway up --service web && railway up --service backup
    railway run --service api node dist/seed.mjs   # staging only; never in production
    ```
    Railway may also pull the GHCR images (`ghcr.io/giancolombi/slai-*:main`)
    instead of building; the pre-deploy command works the same.
  - Postgres backups: enable Railway's native volume backups (daily, and weekly
    kept longer) in addition to the `backup` cron (TR-38).
- **TR-41** Vendors and subprocessors:

  | Vendor | Purpose | Customer data it processes | Assurance |
  |---|---|---|---|
  | Anthropic | Primary model provider (triage, drafts, contract extraction) | Ticket text, knowledge snippets, contract text, per request | Commercial API, no training on API data; ZDR requested (TR-16, TR-17); SOC 2 Type II |
  | OpenAI | Fallback model provider | Same as Anthropic, only on provider errors | Commercial API, no training on API data; SOC 2 Type II |
  | E2B | Sandboxes that run the agents | The run's input manifest (ticket text, no credentials), for the run's life | SOC 2 Type II; sandboxes destroyed after each run |
  | Railway | Hosting: containers, Postgres, object storage (buckets) | All stored data | SOC 2 Type II (trust.railway.com) |
  | Email provider (TBD; SMTP with TLS) | Alert and invitation email | Recipient addresses, ticket keys and subjects in alerts | To choose with a DPA and SOC 2 report |
  | GitHub | Source, CI, container registry (GHCR) | None (code and images only) | SOC 2 Type II |
  | Stripe | Billing (T-65) | Billing contacts and payment data (Stripe-hosted) | PCI DSS Level 1, SOC 2 |
  | Customer's help desk and Slack | Their own systems we read from and write to | Their data, under their accounts | The customer's vendors, not ours |

  A new subprocessor needs this table updated and customers notified per the DPA.
- **TR-42** Data-flow classification:

  | Data | Class | Stored in | Processed by | Retention |
  |---|---|---|---|---|
  | Ticket subjects, requester names and emails, comment bodies | Customer confidential (may contain end-user PII) | Postgres (RLS) | api, worker, model providers, E2B | comment bodies 400 days (TR-30b); rest while the org exists |
  | Ticket events, SLA outcomes, evaluations | Customer confidential | Postgres | api, worker | while the org exists |
  | Contracts (files, extracted text, citations) | Customer confidential | Object storage (SSE), Postgres | worker, model providers | until archived + 30 days, or org deletion |
  | Help-desk credentials, webhook secrets, Slack webhooks, SSO secrets | Secret | Postgres, AES-256-GCM (TR-27) | api, worker (in memory) | until removed; rotated per TR-27a |
  | Passwords, TOTP secrets, backup codes, passkeys, sessions | Secret | Postgres, `slai_auth` only | api (better-auth) | sessions to expiry; the rest until removed |
  | Member names and emails | Personal | Postgres | api, worker, email provider | while the account exists |
  | Audit events, usage ledger, credit grants | Compliance records | Postgres (append-only) | api, worker | at least 1 year, kept after org deletion |
  | Knowledge articles | Customer internal | Postgres | worker, model providers | while the source exists |
  | Backups | All of the above | Backup bucket | backup job | 35 days daily, 12 months monthly (TR-38) |
  | Logs | Operational (no bodies, secrets redacted) | Platform logs | — | 30 days |
- **TR-43** Incident response (outline):
  1. **Detect**: alerts on 5xx rate, failed jobs, `/readyz` and worker `/healthz`,
     audit anomalies (failed sign-ins, unexpected exports or deletions), vendor
     notices, customer reports.
  2. **Triage** within 1 hour: an incident lead is named; severity SEV1 (data
     exposure or outage), SEV2 (degraded, no exposure), SEV3. Open an incident
     record (timeline, decisions).
  3. **Contain**: revoke sessions (delete rows), rotate exposed keys (TR-27a) and
     provider keys, pause connections or autonomy (observe), block IPs at the edge,
     take a backup for forensics.
  4. **Eradicate and recover**: fix, deploy, restore from backup if needed (TR-38),
     verify with the audit trail.
  5. **Notify**: affected customers within 72 hours of confirming a personal-data
     breach (or sooner per contract); regulators where required.
  6. **Review** within 5 business days: blameless post-mortem, action items in
     `specs/tasks.md`, controls updated here. The audit trail is evidence and is
     never pruned during an investigation.
- **TR-44** Access review (quarterly, and when someone joins, changes role or
  leaves):
  - Infrastructure: Railway project members, GitHub org and repo admins, GHCR,
    secrets holders, Stripe, model provider and E2B consoles. Remove anyone
    without a current need; enforce SSO/MFA on each.
  - Product: per org, owners and admins (`GET /members`), SSO providers; the
    audit log (`member.*`, `org.*`, `auth.*`) for the quarter.
  - Database roles: only `slai`, `slai_app`, `slai_worker`, `slai_auth` exist;
    passwords rotated when an operator leaves.
  - Record each review (who, when, findings, changes) with the incident records;
    a key rotation (TR-27a) is recorded the same way.

### Local development
- **TR-32** `docker compose up -d` (Postgres 18 on 5433, Mailpit) →
  `pnpm db:migrate && pnpm db:seed` → `pnpm dev`.
  - `MODEL_PROVIDER=mock`, `AGENT_RUNTIME=local`, and the `demo` connector run the
    whole product with no external accounts.
  - The web app also runs standalone with `VITE_MOCK_API=1`.
