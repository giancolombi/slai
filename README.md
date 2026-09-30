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

```bash
pnpm install
cp .env.example .env   # then fill ENCRYPTION_KEY and SESSION_SECRET (see .env.example)
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev               # web :5173, api :8787, worker
```

With `MODEL_PROVIDER=mock` and `AGENT_RUNTIME=local`, everything runs without API keys,
and the `demo` connector simulates a help desk.

## Docs

- [Architecture](docs/ARCHITECTURE.md) and [ADRs](docs/adr)
- [SLA semantics](docs/SLA_SEMANTICS.md): exactly how clocks are measured
- [Connector research](docs/research/CONNECTORS.md), [pricing research](docs/research/PRICING.md)
- [AGENTS.md](AGENTS.md): invariants and conventions for contributors (human or AI)
