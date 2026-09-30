# slai: product specification

## 1. Problem

SaaS and technology companies sign support SLAs with their customers, such as "P1 first
response within 1 hour, 24x7" or "resolution within 3 business days". Missing them costs
service credits (typically 5–25% of the monthly fee per period), renewal leverage, and
churn. Help desks show timers for *their own* SLA configuration. That configuration is
often wrong, stale, or missing the contract's nuances: per-customer tiers, business
calendars, pause rules, and attainment-based credits. Nobody is accountable for the
contract itself.

## 2. Users

| Persona | Needs |
|---|---|
| **Buyer:** VP or Head of Support / CX (sometimes CFO or RevOps) | Stop paying credits; prove attainment to customers and leadership |
| **Support ops** | Turn contracts into correct policies; decide how much agents may do |
| **Support agent** | Know what is about to breach; get a good draft fast; approve in one click |

## 3. Product requirements

IDs are referenced from `technical.md` and `tasks.md`.

### Contracts and policies
- **PR-1** A user uploads SLA contracts (PDF, DOCX, TXT, MD; ≤ 20 MB), optionally
  linked to a customer account.
- **PR-2** slai extracts one policy per SLA schedule in the contract:
  - targets per metric × priority, business hours and time zone, holidays, pause rules,
    and service-credit clauses
  - the parties, fee, and effective date
- **PR-3** Every extracted value shows a **verbatim citation** from the contract.
  Any value without a verified citation is raised as an **ambiguity**.
- **PR-4** A policy cannot be approved until every ambiguity is confirmed or changed.
  Only admins approve. Policies are versioned; approving supersedes the previous
  version, and every approval is audited.
- **PR-5** A user can also create or edit a policy by hand, and preview it against
  history ("this policy would have produced N breaches in the last 90 days").

### Help-desk connections
- **PR-6** Connect a help desk with credentials or OAuth. Launch set: Zendesk, Jira
  Service Management, Intercom, Freshdesk, HubSpot, and Zammad. Next: Salesforce
  Service Cloud, ServiceNow, Zoho Desk, Front, Gorgias, Help Scout, Linear, and
  GitHub Issues.
- **PR-7** Tickets stay current via webhooks plus a periodic catch-up sync. A
  connection shows its status, last sync, and last error.
- **PR-8** Customers can override how the help desk's statuses and priorities map to
  slai's.
- **PR-9** A built-in **demo** help desk lets anyone try slai with no vendor account.

### Customers
- **PR-10** Customer accounts (our customer's customers) have domains, help-desk org
  ids, a monthly fee, and an assigned policy. Tickets are matched to accounts
  automatically, by help-desk org first and then by the most specific email domain.
  Unmatched tickets use the default policy.

### SLA monitoring
- **PR-11** Every open ticket shows each SLA clock:
  - state (running / paused / achieved / breached)
  - elapsed and remaining time, and the exact due time
  - risk: ok → warning → at risk → breached
- **PR-12** Risk changes at the right instant even when nothing happens on the ticket.
- **PR-13** Every breach is explainable: the event timeline, the policy version, and
  the arithmetic.
- **PR-14** Alerts go in-app, by email, and to Slack when a ticket crosses a
  channel's minimum risk, once per crossing.

### Agent workforce
- **PR-15** Autonomy rules set per customer and priority (most specific wins; the
  default is observe):
  - the level: **observe** (alerts only), **assist** (triage plus a draft for
    one-click approval, also posted as an internal note), or **autopilot** (the draft
    is sent automatically if it passes the guardrails)
  - the risk level that triggers agents
  - the minimum confidence
- **PR-16** Triage produces a summary, category, suggested priority and owner,
  sentiment, and a "needs a human" flag with a reason.
- **PR-17** Drafts never invent facts, and they flag timeline promises,
  pricing/refunds, legal/security topics, and uncertainty. Autopilot never sends a
  flagged draft.
- **PR-18** An approvals inbox where drafts can be edited, approved and sent, or
  rejected. It is keyboard friendly.
- **PR-19** Many agents run concurrently, each in an isolated sandbox.
- **PR-20** (Later) Agents resolve tickets rather than only answer them, e.g. by
  reproducing bugs, looking up accounts, or running runbooks.

### Money and reporting
- **PR-21** The dashboard shows:
  - open tickets by risk, and what is due soon
  - attainment and its trend
  - breaches and dollar exposure this period
  - breaches saved, and pending approvals
- **PR-22** **Breach Replay** replays the last N days (default 90) of a connection
  against the policies and reports:
  - breaches and attainment
  - dollar exposure from the credit clauses, per customer and per metric
  - the median warning slai would have given
- **PR-23** Usage and billing: credits used, cost by kind, tracked tickets, and a
  spend cap.

### Accounts and trust
- **PR-24** Email/password sign-up and login, TOTP MFA (orgs can require it),
  multiple orgs per user, and roles owner/admin/member/viewer.
- **PR-25** An audit log of every security-relevant action.
- **PR-26** SOC 2-ready from day one. Customer data is never used for model
  training.

## 4. Pricing

A platform fee by **SLA-tracked tickets**, plus **prepaid AI credits** at fixed
per-action prices (1 credit = $0.01):

| Action | Credits |
|---|---|
| Triage | 3 |
| Draft | 20 |
| Autopilot reply | 60 |

There is no per-seat pricing, because autopilot reduces seats. We don't use a
share-of-savings model, because attribution is disputable. It appears only as an
Enterprise guarantee.

| Tier | Price | Includes |
|---|---|---|
| Replay | Free | One-time 90-day Breach Replay; read-only connection; no card |
| Starter | $299/mo | 1,500 tracked tickets; observe + triage |
| Growth | $999/mo | 7,500 tracked tickets; assist |
| Scale | $2,499/mo | 25,000 tracked tickets; autopilot |
| Enterprise | from ~$50k/yr | Committed credits, SSO, optional breach-prevention guarantee |

- The spend cap defaults to included credits + 50%, with alerts at 50%, 80%, and 100%.
- At the cap, autonomy degrades: autopilot → assist → observe.
- **SLA monitoring and alerts are never throttled.**
- Go-to-market: free Replay → 14-day Growth trial (autopilot off) → sales-assisted
  above 25k tickets or more than $25k per quarter of exposure found.

For comparison, Intercom Fin charges $0.99 per resolution and Zendesk AI agents
$1.50–$2.00 per automated resolution. Sierra and Decagon use outcome-based enterprise
contracts, which are not public.

## 5. Out of scope for v1

- Uptime and availability SLAs (Datadog, PagerDuty, Statuspage)
- SSO/SAML and SCIM
- EU data residency and customer-managed keys
- Credit-memo automation
