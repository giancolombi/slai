# slai: product spec (v1)

## Problem

SaaS and technology companies sign support SLAs with their customers, such as "P1 first
response within 1 hour, 24x7" or "resolution within 3 business days". Missing them costs
service credits (typically 5–25% of the monthly fee per period), renewal leverage, and
churn. Help desks show SLA timers, but they measure the help desk's own SLA
configuration. That configuration is often wrong, stale, or missing the contract's
nuances (per-customer tiers, business calendars, pause rules, attainment-based credits).
Nobody is accountable for the contract itself.

## Who buys and who uses it

- **Buyer:** VP or Head of Support, or CX leader, at a B2B SaaS company with enterprise
  contracts. Sometimes the CFO or RevOps, because credits hit revenue.
- **Users:** support ops (policies, autonomy), support agents (approvals, drafts),
  and leadership (dashboard, replay reports).

## What v1 does

1. **Contracts → policies.** Upload MSAs, SLA schedules, or order forms (PDF, DOCX,
   text). An agent extracts every SLA schedule:
   - targets by metric and priority, business hours and time zone, holidays,
     pause rules, and credit clauses
   - a **verified citation** for every number
   - an **ambiguity** for anything the contract doesn't settle

   A human resolves the ambiguities and approves. Policies are versioned.
2. **Connect help desks.** Zendesk, Jira Service Management, Intercom, Freshdesk,
   HubSpot, and Zammad first. The rest follow `docs/research/CONNECTORS.md`.
   Connections use webhooks plus polling.
3. **Deterministic clocks.** Every ticket is matched to a customer account and its policy,
   and is evaluated continuously (see `SLA_SEMANTICS.md`):
   - risk moves ok → warning → at_risk → breached
   - due times are exact, and precise timers fire even when nothing happens on the ticket
4. **Agent workforce** (E2B sandboxes, many concurrent). On a risk crossing, and
   according to autonomy rules per customer and priority:
   - **observe**: alert (in-app, Slack, email)
   - **assist**: triage, plus a reply draft posted as an internal note and queued for
     one-click approval in slai
   - **autopilot**: the same, and if the draft passes the guardrails it is sent as the
     public reply
5. **Breach Replay.** Replays the last 90 days against the approved contracts and shows
   breaches, dollar exposure from the credit clauses, attainment per customer, and how
   much warning slai would have given. This is the free lead magnet.
6. **Money view.** Attainment, exposure, and "breaches saved" per period and per customer.

## Later (post-v1)

- Agents that **resolve** tickets rather than only answer them: reproduce bugs against the
  customer's systems, look up accounts, and run runbooks.
- Uptime and availability SLAs (Datadog, PagerDuty, Statuspage) and their credits.
- SSO/SAML and SCIM, data residency (EU), and customer-managed keys.
- Credit memo automation and contract renewal insights.

## Pricing (from `research/PRICING.md`)

A platform fee by **SLA-tracked tickets**, plus **prepaid AI credits** at fixed
per-action prices (triage, draft, autopilot reply). No per-seat pricing, because
autopilot reduces seats.

| Tier | Price | Includes |
|---|---|---|
| Replay | Free | One-time 90-day Breach Replay. Read-only connection, no card |
| Starter | $299/mo | 1,500 tracked tickets; observe + triage |
| Growth | $999/mo | 7,500 tracked tickets; assist (drafts) |
| Scale | $2,499/mo | 25,000 tracked tickets; autopilot |
| Enterprise | from ~$50k/yr | Committed credits, SSO, optional breach-prevention guarantee |

The spend cap defaults to included credits + 50%. At the cap, autonomy degrades from
autopilot to assist to observe. **The SLA clock and alerts are never throttled.**

## Non-negotiables

- SOC 2 controls from day one (see `SOC2.md`).
- Commercial model APIs only (ADR-004); customer data is never used for training.
- Every breach claim is explainable from the event timeline, the policy version, and the
  arithmetic.
