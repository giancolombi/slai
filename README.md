# slai

**Never miss an SLA again.** slai reads the support SLAs you've signed with your
customers, runs every ticket against them on a deterministic clock, warns before
a breach happens, and deploys AI agents in sandboxes to triage, draft, or answer
in time.

- Upload your SLA contracts. slai extracts the policy with a citation for every
  number, and you approve it.
- Connect your help desk: Zendesk, Jira Service Management, Intercom, Freshdesk,
  HubSpot, and more.
- See each ticket's clocks: ok → warning → at risk → breached, with exact due times
  in business hours.
- Choose how much the agents may do, per customer and priority: **observe**
  (alerts), **assist** (drafts for one-click approval), or **autopilot** (replies
  within guardrails).
- Free **Breach Replay** runs your last 90 days against your contracts and shows
  what you missed and what it cost.

## Quick start

Requires Node 24+, pnpm 11 (`corepack enable`), and Docker.

```bash
pnpm install
pnpm setup:env                       # writes .env with generated secrets
docker compose up -d postgres mailpit
pnpm db:migrate && pnpm db:seed
pnpm dev                             # web :5173 · api :8787 · worker
```

Open http://localhost:5173 and sign in as `demo@slai.dev` / `slai-demo-password-1`.
The seeded **Demo Help Desk** syncs about 450 realistic tickets within a minute. The
worker evaluates them, and agents draft replies for at-risk tickets under the
seeded autonomy rules. Alert emails land in Mailpit at http://localhost:8025.

By default `MODEL_PROVIDER=mock` and `AGENT_RUNTIME=local`, so nothing needs API
keys. The mock only understands simple SLA wording. For real contracts, set
`MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env` (plus
`OPENAI_API_KEY` for fallback), then restart `pnpm dev`.

**Test with your own SLA:** go to Contracts, then Upload (PDF, DOCX, TXT or MD).
Resolve the questions on the review screen, approve, and assign the policy to a
customer under Customers.

`pnpm check` runs lint, typecheck and every test (tests need the Postgres container).

## Specs

- [Product spec](specs/product.md): problem, users, requirements, pricing
- [Technical spec](specs/technical.md): architecture, SLA semantics, security
- [Tasks](specs/tasks.md): the implementation plan and its status
- [AGENTS.md](AGENTS.md): invariants and conventions for contributors (human or AI)
