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
- **PR-23** Usage and billing: the plan and its status, a trial banner, tracked
  tickets against the plan's limit, credits against included + purchased and the
  spend cap, cost by kind, invoices, upgrade (Stripe Checkout), buy credit packs,
  and manage payment methods (Stripe Customer Portal). Owners and admins make
  changes; everyone in the org can see it. Pricing specifics are in §4.

### Accounts and trust
- **PR-24** Identity and access:
  - Email/password sign-up and sign-in, email first: the email's domain decides
    between a password and the organization's SSO.
  - **MFA is mandatory for every password account.** After the first sign-in the
    user must enroll a second factor (an authenticator app with ten single-use
    backup codes, or a passkey) before anything else works, and every sign-in
    asks for it (TOTP, a backup code, or a passkey). There is no org toggle.
    Existing users are forced into enrollment at their next sign-in.
  - **SSO per organization** (OIDC or SAML), set up by admins and owners: provider
    details (the client secret is write-only), DNS TXT domain verification, JIT
    provisioning of new users as `member`, an **enforce SSO** switch that disables
    password and passkey sign-in on the verified domains, and an "also require slai
    MFA for SSO users" switch (off by default: the IdP's MFA counts), and a
    "require the IdP to assert MFA" switch that refuses SSO sign-ins whose IdP
    does not say it used MFA.
  - Settings → Security lets users manage their authenticator app, regenerate
    backup codes, and add or remove passkeys (never the last factor).
  - **Factor recovery.** A member who lost their device and backup codes asks an
    admin: Team → member menu → "Reset two-factor" (a reason, and the admin's own
    fresh TOTP or passkey). It removes the member's factors, signs them out
    everywhere, emails them, and they enroll again at the next sign-in. Admins
    cannot reset owners, nobody resets themselves this way, and an org's only
    owner is recovered by slai support through the break-glass procedure.
  - **SCIM provisioning** for SSO customers (Okta, Entra ID): admins generate a
    SCIM token in SSO settings; the IdP creates, updates and deactivates members
    (deactivation signs them out), and IdP groups can be mapped to roles
    (e.g. "slai-admins" → Admin).
  - Multiple orgs per user, and roles owner/admin/member/viewer.
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

| Tier | Price | Tracked tickets / mo | Included credits / mo | Agents may |
|---|---|---|---|---|
| Replay | Free | (Replay only) | 0 | observe; one-time 90-day Breach Replay, read-only connection, no card |
| Starter | $299/mo | 1,500 | 5,000 ($50) | observe + triage |
| Growth | $999/mo | 7,500 | 20,000 ($200) | assist (drafts for approval) |
| Scale | $2,499/mo | 25,000 | 60,000 ($600) | autopilot |
| Enterprise | from ~$50k/yr | by contract | 250,000 by default, committed | autopilot; SSO; optional breach-prevention guarantee |

The plans are code: `packages/shared/src/plans.ts` is the single source for
prices, limits, credits and agent ceilings (API, worker and web all read it).

**Why these credit allowances.** At the per-action prices, model and sandbox cost
is 25–50% of the credit price (50–75% margin), so included credits cost us
$12–25 on Starter, $50–100 on Growth and $150–300 on Scale: 4–12% of the fee. Each allowance covers the plan's intended use:
Starter triages every tracked ticket once (1,500 × 3 = 4,500); Growth drafts for
about 1,000 at-risk tickets; Scale sends about 1,000 autopilot replies (or 3,000
drafts). Heavier use buys credit packs or runs into the overage allowance.

- **Tracked tickets.** A ticket counts once in a calendar month (UTC) if any of its
  SLA cycles was live during it (started before the month ended, not stopped
  before it began). Over the limit, **monitoring never stops**: the overage is
  flagged on the billing page, the owner is emailed once a month, and each extra
  ticket is billed at **$0.20** in arrears (just above Starter's per-ticket
  price, so a larger plan is cheaper for sustained use). Nothing is blocked.
- **Credits.** Consumption draws on included credits first, then purchased
  credits, then overage. Purchased credits come in packs (10,000 for $100; 50,000
  for $450), never expire, and carry over. Overage credits are billed at 1 cent
  each in arrears.
- **Spend cap.** By default: included + purchased + 50% of included (the overage
  allowance), with alerts at 50%, 80%, and 100%. The owner or an admin can set an
  explicit monthly cap instead. At the cap, agents degrade to observe until the
  next month or until the cap is raised.
- **Trial.** Every new org starts on a **14-day Growth trial**: drafts for
  approval, **autopilot off**, 5,000 credits, no card, no overage (the cap is
  the allowance). The owner is emailed at 3 days left. At expiry with no
  subscription, agents drop to observe-only; monitoring and alerts continue.
- **Failed payments.** A past-due subscription keeps its plan for a **7-day grace
  period**, then agents degrade to observe until the invoice is paid. Canceled is
  observe-only.
- **SLA monitoring and alerts are never throttled**, in any plan or state.
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
