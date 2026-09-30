# slai — Architecture

slai keeps SaaS companies inside the support SLAs they have signed with their
customers. A customer uploads their SLA contracts and connects their help desk.
slai turns each contract into an approved, machine-checkable policy, runs every
open ticket against it on a deterministic clock, predicts breaches before they
happen, and dispatches sandboxed AI agents to triage, draft, or (when allowed)
answer the ticket in time.

## The one rule

**The SLA clock is code, never a model.** Whether a ticket breached, when it
will breach, and what a breach costs are computed by `@slai/sla-engine` — a
pure, deterministic, exhaustively-tested library. Models are used for three
things only, and every model output is validated and bounded before it
touches state:

1. **Contract → policy draft** (a human must approve before it is live).
2. **Ticket → triage** (category, suggested priority, owner, summary).
3. **Ticket → reply draft** (sent by a human, or by autopilot when the
   customer has enabled it for that scope).

If a customer disputes a breach, we show the exact event timeline, the policy
version, and the arithmetic. That is the product's credibility.

## System diagram

```
            ┌──────────────────────── customer's help desk ─────────────────────────┐
            │ Zendesk · Freshdesk · Jira SM · HubSpot · Intercom · Help Scout · ... │
            └──────────┬───────────────────────────────▲────────────────────────────┘
          webhooks +   │ polling sync                  │ notes / replies / assign
                       ▼                               │ (via connector write API)
┌────────────┐   ┌───────────────┐   jobs (pg-boss)  ┌─┴──────────────┐    ┌─────────────────┐
│  apps/web  │──▶│   apps/api    │──────────────────▶│  apps/worker   │───▶│  E2B sandboxes  │
│ React SPA  │   │ Hono (REST)   │                   │ sync · eval ·  │    │ one per agent   │
└────────────┘   │ auth · RBAC · │◀──────────────────│ timers · agents│◀───│ run; no DB, no  │
                 │ audit · upload│                   └──────┬─────────┘    │ creds, egress   │
                 └──────┬────────┘                          │              │ allowlisted     │
                        ▼                                   ▼              └─────────────────┘
                 ┌──────────────────────────────────────────────────┐
                 │ PostgreSQL — row-level security per organization  │
                 │ tickets · events · evaluations · policies · runs │
                 │ audit (append-only) · usage ledger               │
                 └──────────────────────────────────────────────────┘
```

## Packages

| Package | Responsibility | I/O? |
|---|---|---|
| `packages/sla-engine` | Business calendars, clock math, per-metric cycles, risk, attainment, service credits | none — pure |
| `packages/connectors` | One adapter per help desk → canonical tickets/events; webhook verification; write-back | HTTP only (injected `fetch`) |
| `packages/agents` | Contract extraction, triage, drafting; provider routing (Anthropic/OpenAI); metering; E2B runtime | model + E2B APIs |
| `packages/db` | Drizzle schema, migrations, RLS, org-scoped query helper | Postgres |
| `packages/shared` | API DTOs and enums shared by API and web | none |
| `packages/ui` | The slai design system (tokens + React components) | none |
| `apps/api` | HTTP API, auth, RBAC, audit, webhook intake, contract upload | Postgres, object storage |
| `apps/worker` | Sync, evaluation, breach timers, agent dispatch, write-back, replay | everything |
| `apps/web` | The product UI | API only |
| `sandbox/` | E2B template: the code that runs inside the agent sandbox | model API via allowlisted egress |

## Data flow for one ticket

1. A connector webhook (or the polling sync) tells us ticket `T` changed.
2. The worker fetches `T`'s history, maps it to canonical `TicketEvent`s,
   upserts them idempotently, and resolves which **policy** applies
   (customer-account match → default policy).
3. `evaluateTicket(policy, events, now)` produces the evaluation. We store it,
   write per-cycle outcomes to `sla_outcomes`, and compute `next_check_at` —
   the earliest of the next warn threshold or due time.
4. A timer sweep re-evaluates tickets whose `next_check_at` has passed. So a
   ticket that nobody touches still transitions ok → warning → at_risk →
   breached at the right instant, with no dependence on help-desk events.
5. On a risk transition, the **autonomy rules** for the ticket's scope decide:
   - `observe`: notify (in-app, Slack, email).
   - `assist`: run triage + draft in a sandbox; post as an internal note
     and/or queue it for one-click approval in slai.
   - `autopilot`: same, and if the draft passes guardrails (confidence
     threshold, no policy/pricing/legal commitments, customer allowed the
     category), send the public reply through the connector.
6. Every model call and sandbox second is metered to `usage_ledger`; the
   org spend cap degrades autopilot → assist → observe, never the clock.

## Why these choices

See `docs/adr/`. In short:

- **TypeScript end to end** (ADR-001). The workload is I/O-bound (help-desk
  APIs, model APIs, sandboxes). E2B, the Anthropic and OpenAI SDKs, and most
  help-desk SDKs are TypeScript-first. One language across web, API, worker and
  the engine means shared types, including the SLA types the UI renders.
- **Postgres as the queue and the timer store** (ADR-002). SLA timers are "re-evaluate
  ticket T at instant X". That is an indexed column plus a sweep, backed by
  pg-boss jobs. It is one less system in SOC 2 scope than Temporal, and it is
  transactional with the data it schedules.
- **E2B for every agent run** (ADR-003). Ticket bodies and contracts are
  untrusted input (prompt-injection surface). The agent runs in a disposable
  sandbox with no database, no connector credentials, and egress allowlisted to
  the model provider. It returns a proposal. The worker validates it and is the
  only thing that writes.
- **API keys, not consumer subscriptions** (ADR-004).
