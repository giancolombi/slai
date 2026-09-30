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
   send (after `decideAutopilot` guardrails).
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
- **TR-12** The canonical status categories are new, open, pending (waiting on the
  requester), on_hold (third party), solved, and closed.
  - Each connector ships a default mapping that the customer can override.
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
    reply stops the clock.
- **TR-21d** Metering: model calls go to `usage_ledger` as `model_call` rows (tokens,
  micro-dollars), plus `sandbox_seconds` rows. Credits are on the first row of a
  successful run: triage 3, draft 20. An autopilot send adds an `autopilot_reply`
  row at 60. The spend cap compares this month's credits (1 credit = 1 cent) with
  `monthly_spend_cap_cents`. Reaching 50/80/100% is recorded once per month
  (`usage.cap_threshold` audit event) and sent to every enabled channel.
- **TR-21e** Breach Replay stores the replayed tickets through the same idempotent
  ingest, but sends no alerts and dispatches no agents. Exposure is
  `computeCredits` per customer per calendar month, using the customer's fee.
  The lead is `breachAt` minus the first at_risk instant, found by stepping the
  engine through event times and `nextTransitionAt`. Policy preview runs inline
  in the API.

### API (PR-24, PR-25)
- **TR-22** The contract is `packages/shared/src/api.ts`: base `/api/v1`, JSON,
  errors as `{error:{code,message}}`, lists as `{items,nextCursor}`, money in cents,
  durations in ms, times as ISO strings.
- **TR-23** Auth:
  - argon2id passwords
  - DB sessions storing only the sha256 of the token; httpOnly cookie
    `slai_session`, 12h idle / 7d absolute
  - TOTP MFA (orgs can require it)
  - login rate limiting and generic errors (no user enumeration)
- **TR-24** CSRF defense: SameSite=Lax, an Origin check, and `X-Requested-With: slai`
  on mutations. RBAC comes from the membership role.
- **TR-25** Uploads are checked by magic bytes (not extension) and sha256-hashed,
  behind a storage-driver interface (local now; GCS/S3 later).

### Security and SOC 2 (PR-26)
- **TR-26** Tenant isolation lives in Postgres:
  - `org_id` plus an RLS policy on every org-scoped table, with FORCE RLS
  - the app role is `slai_app` (NOBYPASSRLS)
  - all org queries go through `withOrg`, which sets `app.org_id` per transaction
- **TR-27** Secrets (connector credentials, MFA secrets, Slack webhooks) use
  AES-256-GCM with a key id, so keys can rotate. They are never logged, never
  returned by the API, and never passed into a sandbox.
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
  | CC6.1 Least privilege | Column grants: `slai_app` cannot read password hashes, MFA secrets, or sessions; `slai_worker` cannot read ticket content, credentials, or policies |
  | CC6.1 Authentication and MFA | argon2id; a dummy hash for unknown emails; RFC 6238 TOTP with replay rejection; org `require_mfa` |
  | CC6.1 Sessions | sha256-only token storage; 12h idle / 7d absolute; the token rotates on MFA; server-side logout |
  | CC6.3 RBAC | `requireRole`; the last owner is protected; membership is rechecked on every request |
  | CC6.6 Boundary | CSRF (header + Origin + Sec-Fetch-Site); CORS locked to `APP_URL`; body limits; login and webhook rate limits; webhook signatures |
  | CC6.7 Encryption at rest | AES-256-GCM with a key id and context-bound AAD for every secret; secrets masked in the API |
  | CC6.8 Uploads | Magic-byte sniffing; 20 MB cap; sanitized names; server-generated storage keys |
  | CC7.2 Audit and logs | `audit()` in the same transaction; a trigger blocks UPDATE/DELETE/TRUNCATE; pino redaction; no request bodies in logs |
  | CC8.1 Change integrity | Policies need `parsePolicy` and admin approval; versions are superseded, never edited in place |
  | PI1 Billing integrity | Append-only `usage_ledger`; money figures come only from the engine |

- **TR-31** CI (lint, typecheck, test against Postgres) must pass before merging to
  main.

### Local development
- **TR-32** `docker compose up -d` (Postgres 18 on 5433, Mailpit) →
  `pnpm db:migrate && pnpm db:seed` → `pnpm dev`.
  - `MODEL_PROVIDER=mock`, `AGENT_RUNTIME=local`, and the `demo` connector run the
    whole product with no external accounts.
  - The web app also runs standalone with `VITE_MOCK_API=1`.
