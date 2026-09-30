# slai: implementation tasks

Status: `[x]` done (merged to main, tests passing) · `[~]` in progress · `[ ]` to do.
Each task references the requirements it serves.

## M0: Foundation
- [x] T-01 Monorepo: pnpm workspaces, TS strict, Biome, vitest, CI workflow (TR-1, TR-31)
- [x] T-02 SLA engine: calendars (business hours, holidays, DST), metric cycles, pauses,
      reopen, priority rules, risk, `mostUrgent` (TR-4 to TR-8)
- [x] T-03 SLA engine: policy schema and validation, attainment, service credits (TR-9, TR-10)
- [x] T-04 SLA engine: `nextTransitionAt` for precise timers (PR-12)
- [x] T-05 Contracts: connector interface, agent interface, API DTOs and route table (TR-11, TR-15, TR-22)
- [x] T-06 Worker decision rules: customer matching, policy resolution, autonomy
      resolution, dispatch, notification crossing, spend state (PR-10, PR-14, PR-15, PR-23)

## M1: Data and API
- [x] T-10 `packages/db`: schema for all tables, migrations, roles, RLS + FORCE, `withOrg`,
      append-only audit trigger, AES-256-GCM crypto, job names and payloads, idempotent seed (TR-2, TR-26 to TR-28)
- [x] T-11 API auth: signup, login, logout, sessions, TOTP MFA, org switch, rate limit (PR-24, TR-23)
- [x] T-12 API middleware: RBAC, CSRF, security headers, request id, redacted logging, audit (TR-24, TR-29)
- [x] T-13 API resources: org, members, connectors, connections, webhooks, customers,
      contracts (upload), policies (edit, approve, preview), tickets, actions,
      autonomy rules, notification channels, dashboard, replays, usage, audit, SSE (PR-1 to PR-25)
- [x] T-14 Tests: RLS isolation (DB and API), audit immutability, auth flows, CSRF, RBAC,
      upload validation, webhook signature rejection

## M2: Connectors
- [x] T-20 Shared HTTP, mapping, HMAC, and pagination helpers; rate-limit errors (TR-11, TR-13)
- [x] T-21 Demo connector: deterministic simulated help desk with live ticket flow (PR-9)
- [x] T-22 Zendesk, Freshdesk, Intercom, Jira SM, HubSpot, Zammad (PR-6, TR-14)
- [x] T-23 Salesforce, ServiceNow, Zoho Desk, Front, Gorgias, Help Scout, Linear, GitHub (PR-6)
- [x] T-24 Zammad in docker compose as a live SLA conformance fixture (TR-14)
- [ ] T-26 Move duplicated OAuth token, rate-limit detection, and 401-refresh helpers from tier-2 connectors into `lib/http.ts`
- [ ] T-25 Status/priority mapping override UI and API (PR-8)

## M3: Agents
- [x] T-30 Providers: Anthropic, OpenAI, and mock; routing, fallback, retries, usage and cost (TR-16, TR-30)
- [x] T-31 Contract extraction with citation verification, ambiguities, and repair (PR-2, PR-3, TR-18)
- [x] T-32 Triage and draft agents with prompt-injection hardening (PR-16, PR-17, TR-19)
- [x] T-33 Guardrails: `decideAutopilot` (TR-20)
- [x] T-34 Runtimes: local and E2B (template, runner, bounds, concurrency, always-kill) (PR-19, TR-21)

## M4: Worker
- [ ] T-40 pg-boss setup, queues, and the 15s timer sweep with `SKIP LOCKED` (TR-2, PR-12)
- [ ] T-41 Sync and webhook processing → ingest (idempotent events, comments, customer and
      policy resolution, evaluation, outcomes, `next_check_at`) (PR-7, PR-10, PR-11)
- [ ] T-42 Risk transitions → notifications (in-app, email, Slack) (PR-14)
- [ ] T-43 Dispatch → triage and draft runs → actions; autopilot send via connector; approved-action
      execution; audit every help-desk write (PR-15 to PR-18)
- [ ] T-44 Contract extraction job → draft policies with citations and ambiguities (PR-1 to PR-3)
- [ ] T-45 Breach Replay job (PR-22) and policy preview (PR-5)
- [ ] T-46 Metering to `usage_ledger`; spend-cap degradation (PR-23, TR-30)

## M5: Web
- [x] T-50 Design system: tokens (light/dark), components, SlaClock, SlaBar, TicketTimeline,
      CitationQuote, and the `/design` style guide (TR-3)
- [x] T-51 App shell, API client, mock API mode (MSW) (TR-32)
- [x] T-52 Auth and MFA pages; onboarding wizard (connect → upload → review → replay)
- [x] T-53 Dashboard, tickets list and detail, approvals inbox (PR-11, PR-18, PR-21)
- [x] T-54 Contracts and the contract review screen (citations; ambiguity gating on approve) (PR-3, PR-4)
- [x] T-55 Policies, customers, connections, autonomy rules, replay report, usage, audit, team, settings

- [ ] T-56 Wire SSE live updates (replace polling)
- [ ] T-57 OAuth connect flows (Intercom, HubSpot, Salesforce, Zoho, Help Scout); show the webhook secret for providers that need it pasted
- [ ] T-58 MFA QR code; inline contract text on the review screen; bundle splitting
- [ ] T-59 API contract: document that `approvedBy`/`uploadedBy`/`decidedBy` are user ids; type the invite response; invitation email and accept endpoint

## M6: Integration and launch readiness
- [ ] T-60 End-to-end local run: seed → demo connector → tickets evaluated → at-risk → draft →
      approve → sent (with an automated e2e test)
- [ ] T-61 E2B template built and pinned; a real run with API keys
- [ ] T-62 A real Zendesk sandbox account and a verified live sync
- [ ] T-63 Deployment: containers, managed Postgres, secrets manager, TLS, backups
- [ ] T-64 SOC 2 readiness: access reviews, vendor list (E2B, Anthropic, OpenAI), incident
      response, retention and deletion jobs
- [ ] T-65 Billing: Stripe plans, credit packs, tracked-ticket counting (PR-23)
