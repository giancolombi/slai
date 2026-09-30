# AGENTS.md: how to work in this repo

Read `docs/ARCHITECTURE.md` and the ADRs in `docs/adr/` first.

## Invariants (never break these)

1. **The SLA clock is code.** Breach state, due times, attainment, and credits come
   only from `@slai/sla-engine`. No model output may set or override them.
2. **Agents propose, the worker disposes.** Code in `packages/agents` and `sandbox/`
   never writes to the database or to a help desk. Every agent output is zod-validated
   before use.
3. **Tenant isolation lives in the database.** Every org-scoped table has `org_id` and an
   RLS policy. App code queries through `withOrg(orgId, tx => ...)`, which sets
   `app.org_id` for the transaction. Never query org data outside it.
4. **Secrets are encrypted at rest** (`packages/db` crypto helpers, AES-256-GCM with a
   key id). They are never logged, never returned by the API, and never passed into a sandbox.
5. **Everything security-relevant is audited** through `audit(...)`, append-only: auth, membership,
   connections, policy approvals, autonomy changes, action approvals, and every write to a
   help desk.
6. **Every model call and sandbox second is metered** to `usage_ledger`.
7. **Connectors are pure HTTP adapters.** They take an injected `fetch`, do no persistence,
   read no env vars, and must reject bad webhook signatures.
8. **Consumer AI subscriptions are never used.** API keys only (ADR-004).

## Conventions

- TypeScript strict, ESM, Node 24. `pnpm` workspaces. Biome for lint and format (`pnpm lint`).
- Tests use vitest, next to each package in `test/`. Write the failing test first for any
  behaviour change. Tests must not need network access or real API keys. Connector tests use
  recorded fixtures and a fake `fetch`.
- Validation uses zod at every trust boundary (HTTP bodies, webhook payloads, model outputs,
  policy definitions).
- Money is integer cents; model cost is integer micro-dollars. Durations are ms.
- Times are `Date` in code, ISO strings on the wire, and `timestamptz` in Postgres.
- Keep modules small and names plain. No speculative abstractions.
- `pnpm check` (lint, typecheck, test) must pass before any commit to `main`.

## Layout

See the package table in `docs/ARCHITECTURE.md`.
