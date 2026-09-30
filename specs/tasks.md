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
- [x] T-15 better-auth replaces the hand-rolled auth: Drizzle adapter on a `slai_auth` role,
      sealing adapter (sha256 session tokens, sealed SSO secrets), argon2id kept, migration 0005
      (credential accounts from existing hashes, forced re-enrollment), allowlisted mount behind
      our CSRF/rate limits/audit (PR-24, TR-23, TR-26, TR-27)
- [x] T-16 Mandatory MFA: server-side enrollment gate, TOTP + single-use backup codes, passkeys,
      no trusted devices, last factor protected; demo user pre-enrolled, `pnpm demo:otp` (PR-24, TR-23)
- [x] T-17 SSO per org (OIDC and SAML): admin routes, DNS TXT domain verification, email-domain
      discovery, JIT as member, enforce SSO, "also require slai MFA for SSO users"; tests against
      `oauth2-mock-server` and a software WebAuthn authenticator (PR-24, TR-23, TR-23a)
- [x] T-18 SCIM 2.0 at `/scim/v2` (Users, Groups; Okta and Entra shapes): per-org hashed tokens,
      deactivation disables the membership and revokes sessions, group-to-role mapping in SSO
      settings; minimal subset instead of `@better-auth/scim` (PR-24, TR-23c)
- [x] T-19 IdP `amr`/`acr` recorded on SSO sessions and "require the IdP to assert MFA"; admin reset
      of a member's second factors from Team (step-up, reason, email, audit; no owners by admins,
      no last owner, cross-org rule); `pnpm auth:break-glass` for the last owner (PR-24, TR-23b)
- [x] T-19a SAML end to end against in-test signed assertions (signature, audience, expiry,
      InResponseTo, RelayState, replay, JIT) and the POST binding with SameSite=Lax + CSRF; fixed
      `verifications.id` (uuid → text), which broke every SAML sign-in (TR-23, TR-24)

## M2: Connectors
- [x] T-20 Shared HTTP, mapping, HMAC, and pagination helpers; rate-limit errors (TR-11, TR-13)
- [x] T-21 Demo connector: deterministic simulated help desk with live ticket flow (PR-9)
- [x] T-22 Zendesk, Freshdesk, Intercom, Jira SM, HubSpot, Zammad (PR-6, TR-14)
- [x] T-23 Salesforce, ServiceNow, Zoho Desk, Front, Gorgias, Help Scout, Linear, GitHub (PR-6)
- [x] T-24 Zammad in docker compose as a live SLA conformance fixture (TR-14)
- [x] T-26 Move duplicated OAuth token, rate-limit detection, and 401-refresh helpers from tier-2 connectors into `lib/http.ts`
- [x] T-25 Status/priority mapping override UI and API (PR-8)

## M3: Agents
- [x] T-30 Providers: Anthropic, OpenAI, and mock; routing, fallback, retries, usage and cost (TR-16, TR-30)
- [x] T-31 Contract extraction with citation verification, ambiguities, and repair (PR-2, PR-3, TR-18)
- [x] T-32 Triage and draft agents with prompt-injection hardening (PR-16, PR-17, TR-19)
- [x] T-33 Guardrails: `decideAutopilot` (TR-20)
- [x] T-34 Runtimes: local and E2B (template, runner, bounds, concurrency, always-kill) (PR-19, TR-21)

## M4: Worker
- [x] T-40 pg-boss setup, queues, and the 15s timer sweep with `SKIP LOCKED` (TR-2, PR-12)
- [x] T-41 Sync and webhook processing → ingest (idempotent events, comments, customer and
      policy resolution, evaluation, outcomes, `next_check_at`) (PR-7, PR-10, PR-11)
- [x] T-42 Risk transitions → notifications (in-app, email, Slack) (PR-14)
- [x] T-43 Dispatch → triage and draft runs → actions; autopilot send via connector; approved-action
      execution; audit every help-desk write (PR-15 to PR-18)
- [x] T-44 Contract extraction job → draft policies with citations and ambiguities (PR-1 to PR-3)
- [x] T-45 Breach Replay job (PR-22) and policy preview (PR-5)
- [x] T-46 Metering to `usage_ledger`; spend-cap degradation (PR-23, TR-30)

- [x] T-47 Knowledge sources (help-center articles and saved replies per connection) fed into drafts.
      Without them, drafts flag `unsureOfFacts` and autopilot correctly holds every reply (PR-15, PR-17, TR-21h)
- [x] T-47b Knowledge follow-ups: Zammad knowledge base, help-desk saved replies/macros (`saved_replies`
      sources), Freshdesk subfolders and translations, Intercom translations (TR-21h). Also HubSpot
      knowledge base (beta API) and Freshdesk custom portal domain (`config.portalDomain`)
- [x] T-48 First-connect guard: don't dispatch agents for tickets that were already long breached at first
      sync (avoids a burst of drafts and credit spend on connect) (TR-21f)
- [x] T-49 Make help-desk writes and their action record idempotent across retries (no double send) (TR-21g)
## M5: Web
- [x] T-50 Design system: tokens (light/dark), components, SlaClock, SlaBar, TicketTimeline,
      CitationQuote, and the `/design` style guide (TR-3)
- [x] T-51 App shell, API client, mock API mode (MSW) (TR-32)
- [x] T-52 Auth and MFA pages; onboarding wizard (connect → upload → review → replay)
- [x] T-52a Email-first sign-in with SSO discovery; second-factor step (TOTP, backup code, passkey);
      mandatory enrollment (QR, manual key, backup codes with copy/download, or a passkey);
      Settings → Security and Settings → Single sign-on; MSW mock mode updated (PR-24)
- [x] T-53 Dashboard, tickets list and detail, approvals inbox (PR-11, PR-18, PR-21)
- [x] T-54 Contracts and the contract review screen (citations; ambiguity gating on approve) (PR-3, PR-4)
- [x] T-55 Policies, customers, connections, autonomy rules, replay report, usage, audit, team, settings

- [x] T-56 Wire SSE live updates: one EventSource per tab, cache invalidation per event (coalesced),
      jittered backoff reconnect, a top-bar status, polling only as the fallback; every state the UI
      shows is announced (`action.updated`, run start/finish, replay start) (TR-22a)
- [x] T-57 OAuth connect flows (Intercom, HubSpot, Salesforce, Zoho, Help Scout, Zendesk); show the webhook secret for providers that need it pasted (TR-11a). Real OAuth apps still need registering per provider.
- [x] T-58 Inline contract text on the review screen (`GET /contracts/:id/text`, document pane with
      citation scroll and highlight); bundle splitting (vendor chunks, zod-free entry: entry chunk
      466.6 → 62 kB) (the MFA QR code shipped in T-52a) (PR-4, TR-22b)
- [x] T-59 API contract: `approvedBy`/`uploadedBy`/`decidedBy` documented as user ids, with
      `…ByName` display names on the DTOs; the invite response is the shared `Invitation` DTO
- [x] T-59a Invitation email (`send-invite-email`, token sealed only until sent) and `/invite/:token`:
      sign up there (then MFA enrollment) or sign in (SSO/enforce-SSO honoured) and join with the
      invited role; single use, 7-day expiry, resend/revoke from Team, audited (PR-24, TR-23d)

## M6: Integration and launch readiness
- [x] T-60 End-to-end local run: seed → demo connector → tickets evaluated → at-risk → draft →
      approve → sent (with an automated e2e test)
- [ ] T-61 E2B template built and pinned; a real run with API keys
- [ ] T-62 A real Zendesk sandbox account and a verified live sync
- [x] T-63 Deployment, cloud-agnostic: hardened images for api (and migrate), worker, web and backup;
      `docker-compose.prod.yml` with MinIO verified end to end; s3 storage driver with SSE; production
      guard; trusted-proxy client IPs; optional Postgres rate-limit store; image CI to GHCR with Trivy
      and SBOMs; `db:backup`/`db:restore` with off-site upload and retention; Railway config as code
      (TR-24a, TR-25a, TR-36 to TR-40)
- [x] T-64 SOC 2 readiness in code: retention job, org export and scheduled/cancellable/audited deletion
      (API, worker, Settings UI), `keys:rotate`; vendor list, data-flow classification, incident response
      and access-review procedures (TR-27a, TR-30b, TR-30c, TR-41 to TR-44)
- [x] T-65 Billing: plans as code, plan ceilings in dispatch, tracked-ticket counting and monthly
      snapshots, credits ledger and spend cap, 14-day trial, Stripe Checkout/Portal/credit packs,
      signed idempotent webhook, past-due grace, overage via Billing Meters, manual mode (PR-23, TR-33 to TR-35)
- [ ] T-66 Billing with a real Stripe test account: products, prices and Billing Meters created; Customer
      Portal configured (plan switching); webhook endpoint registered; a full checkout → invoice → overage run
- [ ] T-67 First Railway deploy (needs the founder's Railway account/token and project): create the
      services and buckets per TR-40, set variables and generated secrets, domains, config-file paths;
      confirm the pre-deploy migration, bucket compatibility (SSE header, conditional puts), the
      `TRUST_PROXY` ranges and static egress IPs against real client IPs, native Postgres backups, and a
      restore drill; point `APP_URL`/`API_URL` at the custom domains
- [ ] T-68 Choose the email provider (SMTP over TLS, DPA, SOC 2) and add it to TR-41
- [ ] T-69 Stream org exports to storage (multipart upload) before any org's bundle nears a few hundred MB
- [ ] T-70 If we leave Railway for AWS/GCP: provider IaC, customer-managed KMS keys (`S3_SSE=aws:kms`),
      workload identity instead of storage keys, bucket versioning with a noncurrent-version lifecycle,
      and managed PITR settings (TR-25a, TR-38)
