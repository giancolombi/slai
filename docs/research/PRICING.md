# slai Pricing Research and Recommendation

*Researched 2026-09-29. Where a vendor does not publish prices, the figures come from third-party estimates and are marked as such.*

## TL;DR

1. **Use a hybrid model.** Charge a tiered platform fee, sized by **SLA-tracked tickets per month**, and add **AI credits** that are included in the tier and that the customer can top up. Autonomy level decides which tier a customer needs.
2. **Sell monitoring by volume and AI by action.** Deterministic SLA clocks cost us almost nothing, so they belong in the platform fee. AI triage, drafts and autopilot replies burn credits at published per-action rates. We do not bill raw tokens.
3. **Example prices:** Free 90-day Breach Replay audit, Starter $299/mo, Growth $999/mo, Scale $2,499/mo, and Enterprise from about $50k/yr. An autopilot action costs about $0.60, which sits below Fin ($0.99) and Zendesk ($1.50–$2.00).
4. **Do not make value share (a % of breach savings) the primary model.** Attribution is disputable. Use breach dollars as the ROI story and offer a *breach-prevention guarantee* in Enterprise only.
5. **Protect margin with engineering, not only contracts.** Put hard spend caps on each workspace. Hitting a cap downgrades the customer from autopilot to drafts to alerts, and **monitoring is never throttled**. Also set token and time ceilings on each run and route models by task. From day one, meter cost per action alongside price per action.

---

## 1. How comparable products price

### AI agents for support: outcome or conversation pricing on top of a platform fee

| Product | Model | Public price points |
|---|---|---|
| **Intercom Fin** | Per outcome | **$0.99 per outcome.** An outcome is a confirmed or assumed resolution (24h with no follow-up) or a completed workflow, charged once per conversation. Seats cost $29, $85 or $132 per month. Using Fin on a third-party help desk carries a monthly minimum ([Intercom](https://www.intercom.com/pricing)). Third parties report a $49/mo base with 50 outcomes included for "Fin for platforms", and $9.99 per qualified lead ([Gleap](https://www.gleap.io/blog/intercom-fin-ai-pricing-2026)). |
| **Zendesk AI agents** | Per automated resolution plus seats | **$1.50** per resolution on a committed plan, **$2.00** pay-as-you-go. Each agent seat includes 5, 10 or 15 resolutions per month (Team, Professional, Enterprise). Suite costs $55–$115 per agent per month, and Copilot adds $50 per agent per month ([Zendesk](https://www.zendesk.com/pricing/), [eesel](https://www.eesel.ai/blog/zendesk-ai-dynamic-pricing-resolution), [Voiceflow](https://www.voiceflow.com/blog/zendesk-pricing)). |
| **Freshdesk Freddy AI Agent** | Per session | 500 sessions included, then **$49 per 100 sessions (about $0.49 each)**, or about $0.10 each on Omni ([eesel](https://www.eesel.ai/blog/freshdesk-ai-agent), [Dragapp](https://www.dragapp.com/blog/freshdesk-pricing/)). |
| **Forethought** | Platform fee plus usage (deflections and handed-off tickets) | Quote only. The reported median is about **$74k/yr**, with a range of $36k–$151k. It was reportedly acquired by Zendesk in March 2026 ([Chatarmin](https://chatarmin.com/en/blog/forethought-pricing), [Vendr](https://www.vendr.com/marketplace/forethought-technologies)). |
| **Ada** | Per conversation, having moved away from per-resolution | Quote only. Reported at about $30k/yr to start, a $70k median, and $300k+ for large deployments ([Featurebase](https://www.featurebase.app/blog/ada-cx-pricing), [Macha](https://www.getmacha.com/blog/enterprise-ai-customer-support-pricing)). |
| **Decagon** | Platform fee plus per-conversation or per-resolution fees | Quote only. Reports put the platform fee at about **$50k/yr** and the median contract at about $430k/yr ([Macha](https://www.getmacha.com/blog/enterprise-ai-customer-support-pricing), [Retell](https://www.retellai.com/blog/sierra-vs-decagon)). |
| **Sierra** | Outcome-based: platform fee, per-outcome charges and services | Quote only. Reports put the platform fee at about **$150k+/yr** and outcomes at about **$1–$2.50** each. An unresolved conversation is usually not charged ([Quiq](https://quiq.com/blog/sierra-ai-pricing/), [Coworker](https://coworker.ai/blog/sierra-ai-pricing)). |
| **Siena** | Platform fee plus per conversation | Reported at **$750/mo plus $0.90 per automated conversation**, whatever the outcome. Siena publicly argues against outcome pricing ([Macha](https://www.getmacha.com/blog/siena-ai-complete-guide), [Siena](https://www.siena.cx/blog/conversation-vs-outcome-based-pricing-ai-agent)). |

### B2B support platforms (our closest ICP, the ideal customer profile): seats, with AI as an add-on or credits

| Product | Model | Public price points |
|---|---|---|
| **Pylon** | Per seat, with AI add-ons | Reported at $59, $89 and $139 per seat per month, with minimums of 3 or 7 seats. The AI Assistant costs **$50 per seat per month**. AI Agents are priced by issues resolved and sold on the top tiers only ([Chargebee](https://www.chargebee.com/pricing-repository/pylon/), [Featurebase](https://www.featurebase.app/blog/pylon-pricing)). |
| **Plain** | Seats plus **included AI credits** | Foundation costs $35 per seat and includes 2,000 credits. Horizon costs **$299/mo for 3 seats** ($99 per extra seat) and includes 15,000 credits. **SLAs and business hours are Horizon and above only** ([Plain](https://www.plain.com/pricing)). |
| **Thena** | Per user, with AI included | $29, $79 or $119 per user per month. Starter is capped at 1,000 tickets/mo ([Thena](https://www.thena.ai/pricing)). |

### SLA and ops tooling: cheap monitoring, value in the platform

| Product | Model | Public price points |
|---|---|---|
| **SLA Time and Report (Jira app)** | Per Jira user | From about **$1.25 per user**, billed on the org's *total* Jira user count ([SoftwareAdvice](https://www.softwareadvice.com/project-management/sla-time-and-report-for-jira-profile/), [Atlassian Marketplace](https://marketplace.atlassian.com/apps/1220741/sla-time-and-report-for-jira?tab=pricing&hosting=cloud)). |
| **PagerDuty** | Platform bundles with credit packs | Starter costs **$2,800/yr** for 10 seats and 5k events. Essential costs **$12,000/yr** for 20 seats and 40k events. Extra seats, events and AI actions are bought as credit packs. Legacy Professional costs $21 per user per month ([PagerDuty](https://www.pagerduty.com/pricing/)). |
| **incident.io** | Per user, with a free tier | Basic is free. Team costs $15–$19 per user and Pro costs $25 per user. On-call adds $10–$20 per user. The autonomous AI agent is an add-on on Pro and Enterprise ([incident.io](https://incident.io/pricing)). |

**What the market shows us:**
- Pure SLA timers are a commodity that costs about $1 per user.
- The help desks already bundle basic SLAs. Plain gates SLAs to its $299 tier.
- AI agents cluster at **$0.49–$2.00 per unit of work**. Enterprise vendors add platform fees of $50k–$150k.
- PagerDuty, Plain and Pylon all mix a platform fee with credits or add-ons. Hybrid pricing is the most common model at 37%, up from 25%. AI credit adoption is at 29%, and another 33% plan to adopt credits ([Growth Unhinged 2026](https://www.growthunhinged.com/p/the-state-of-b2b-monetization-in-2026)).

---

## 2. Trade-offs of each model

| Model | Pros | Cons for slai |
|---|---|---|
| **Per seat** | Familiar and predictable. It is how help desks and Pylon bill. | Our value is inversely related to seats, because autopilot *reduces* the human work. Buyers will compare us to $1.25-per-user SLA apps. The cost of a seat does not track our inference cost. **Reject as the primary meter.** |
| **Per ticket monitored** | Tracks the value surface (SLA exposure) and our infra and API cost. Easy to understand, and quotable from help desk data. | High-volume, low-SLA-value customers find it expensive. Customers may "de-scope" tickets to save money. Fix this by counting only tickets with an **active SLA clock**. **Use it as the platform-fee sizing axis.** |
| **Per resolution / outcome** | The strongest ROI story, and it is the benchmark buyers already know (Fin, Zendesk, Sierra). | Customers dispute the definition of a resolution. It gives us an incentive to avoid partial automation, and bills are unpredictable ([Siena](https://www.siena.cx/blog/conversation-vs-outcome-based-pricing-ai-agent)). It also fits us poorly: our core outcome is a **met SLA** rather than a deflected ticket, and our draft mode keeps a human in the loop. **Use it only for the autopilot line item, and even there prefer per action.** |
| **Platform fee + usage** | Covers fixed costs such as integrations and contract parsing. Usage scales with value. Predictable for the buyer. | Two numbers to explain. Customers need spend controls. **Recommended.** |
| **% of breach savings (value share)** | Best alignment, and a compelling pitch ("pay 20% of what we save you"). | Nobody can observe the counterfactual. Would the breach have happened anyway? Service credits are often capped. PagerDuty's own SLA, for example, pays 10% per miss up to 30% of monthly fees ([PagerDuty SLA](https://www.pagerduty.com/standard-service-level-agreement/)). Churn value is speculative. Revenue arrives late and is volatile, finance teams dislike it, and it slows procurement. **Offer it only as an Enterprise guarantee or rider.** |
| **Hybrid (recommended)** | The platform fee sized by tracked tickets gives predictable ARR. Credits are priced per action, which makes them transparent and protects margin. | Needs metering and billing infrastructure from day one. |

### Inference pass-through: cost-plus markup or bundled credits

- **Cost-plus (raw tokens + X%)** is transparent and has no model-price risk for us. However, the invoice becomes unreadable for a VP of Support. Every model upgrade shows up as a line-item change, and we have nothing to optimize for. Keep it for **Enterprise BYO-key** customers only: they pay their own provider, and we add a 15–20% orchestration fee on top of the platform fee.
- **Bundled credits at fixed per-action prices** are the recommended default. The customer sees a price per triage, per draft and per autopilot reply. We keep the savings from caching, batching and model routing. We absorb short-term changes in model prices, and a repricing clause with 60–90 days' notice limits that exposure. Credits also support pooling, rollover and alerts ([Metronome](https://metronome.com/blog/why-ai-pricing-is-moving-to-credits)).

---

## 3. Recommendation

### Unit economics (estimated from current list prices)

| Action | Typical path | Est. cost to us | List price | Gross margin |
|---|---|---|---|---|
| SLA clock and breach prediction | Deterministic, no LLM | about $0.001 per ticket | Included in platform fee | about 95% |
| AI triage (priority, SLA class, routing) | Haiku 4.5, about 8k tokens in and 300 out ($1/$5 per MTok) | about $0.01 | **3 credits ($0.03)** | about 65% |
| Draft reply for a human | Sonnet 5.5, about 20k tokens in (half cached) and 1.5k out ($2/$10 per MTok, cache reads $0.20), about 2 tool loops, plus a 90s E2B sandbox | about $0.06–0.09 | **20 credits ($0.20)** | about 55–70% |
| Autopilot reply (sent without a human) | Sonnet, multi-step with a verification pass, occasional Opus 5.5 escalation ($4/$20) | about $0.15–0.30 | **60 credits ($0.60)** | about 50–75% |

Sources: [Claude pricing](https://claude.com/pricing) and [E2B pricing](https://e2b.dev/pricing). E2B bills $0.000014 per vCPU-second and $0.0000045 per GiB-second, so a 2 vCPU / 4 GiB sandbox costs about $0.17 per hour, or about $0.004 for a 90s run. Sandbox cost is therefore small next to tokens. The Pro plan's $150/mo base is a fixed cost for us. Validate these estimates against real traces in the first 30 days.

**1 credit = $0.01 at the included rate.** The target is at least 60% blended AI margin and at least 75% blended gross margin overall, compared with a 2026 median AI gross-margin target of about 50% ([Growth Unhinged](https://www.growthunhinged.com/p/the-state-of-b2b-monetization-in-2026)).

### Tiers (annual prices; monthly billing is about 15% higher)

| | **Breach Replay** (free) | **Starter** | **Growth** | **Scale** | **Enterprise** |
|---|---|---|---|---|---|
| Price | $0 | **$299/mo** | **$999/mo** | **$2,499/mo** | From about $50k/yr |
| SLA-tracked tickets/mo | Last 90 days, one-time | 1,500 | 7,500 | 25,000 | Custom |
| Ticket overage | n/a | $0.15 | $0.10 | $0.07 | Negotiated |
| Help desk connections | 1 | 1 | 3 | Unlimited | Unlimited |
| Contracts / SLA policies | 5 | 10 | 100 | Unlimited | Unlimited |
| Autonomy | Report only | Observe and alert, plus AI triage | + **Draft** mode | + **Autopilot** (per queue or customer) | All, with policy controls |
| Included credits/mo | 1,000 for trial | 3,000 ($30) | 25,000 ($250) | 100,000 ($1,000) | Committed pool |
| Extra credits | n/a | $0.012 each, PAYG | Packs at $0.010 | Packs at $0.009 | Commit at $0.007–0.008. Optional BYO key plus 15–20% fee |
| Extras | Shareable PDF report | Slack/email alerts | Breach-$ dashboard, contract AI parsing | SSO, audit log, spend policies, API | SLA-backed support, DPA, VPC or region, **breach-prevention guarantee** option |

**How the tiers are designed:**
- Autonomy is the upgrade lever, much as Pylon and Plain gate AI and SLAs to higher tiers.
- Growth is priced against a customer that loses thousands of dollars a month in credits and churn. $999 is under 10% of a $10k/mo loss. Anchor the price at 5–10x ROI.
- The autopilot action price ($0.60) undercuts Fin ($0.99) and Zendesk ($1.50–$2.00). It is billed **per autopilot reply sent**, not per "resolution", which avoids definitional disputes. We still *report* the outcomes: SLA met, reopen rate, and customer satisfaction (CSAT).
- Unused included credits expire monthly. Purchased packs roll over for 12 months.

**The Enterprise breach-prevention guarantee (value-share rider):**
- The customer defines a baseline, measured as breaches and dollar exposure from the 90-day Breach Replay.
- If slai does not cut dollar exposure by an agreed %, we credit back a share of the platform fee.
- In exchange, we can charge a 10–15% higher platform fee.
- This carries the value-share story without making revenue depend on counterfactuals.

### Free trial and PLG (product-led growth) motion

1. **Breach Replay as the lead magnet (no card required).** The customer connects their help desk read-only (OAuth) and uploads 1–5 SLA contracts. We re-run the last 90 days deterministically and produce:
   - the breaches found, by customer and priority
   - dollar exposure, using the contract's credit clauses
   - the breaches we would have predicted, with lead time
   - sample AI drafts on 10 tickets that breached

   Output is a shareable report plus a dashboard. The replay costs little because it is deterministic, apart from about 10–50 draft samples. Gate the full report on a work email.
2. **14-day Growth trial.** It runs live in observe and draft modes with 1,000 credits. **Autopilot is not available in trial**, which reduces both risk and cost.
3. **Conversion trigger.** At the end of the trial, show "breaches prevented" and "$ exposure avoided" next to the tier price.
4. **Sales-assist trigger.** Hand off to sales above 25k tracked tickets, when a customer requests autopilot, or when the replay shows more than $25k per quarter of exposure.

### Metering units to record from day one

These should be event-sourced, immutable, and keyed by `workspace_id`, `helpdesk`, `contract_id`, `customer_account_id` and `ticket_id`.

- **Platform:**
  - tickets ingested
  - **SLA-tracked tickets**: distinct tickets with at least one active clock in the billing month
  - clocks started, paused and stopped
  - business-hours calendars
  - contracts and policies active
  - help desk connections
  - human users, recorded even though we don't bill them
- **SLA outcomes (the value evidence):**
  - predicted at-risk, with lead time
  - alerts sent and acknowledged
  - breaches that occurred
  - at-risk tickets that were then met, and which action they were attributed to
  - dollar exposure for each breach, parsed from contract credit terms
- **AI actions (the billing unit):**
  - action type (triage, draft or autopilot) and autonomy level
  - credits charged
  - drafts accepted as-is, edited or rejected, with edit distance
  - autopilot replies sent
  - reopens and escalations within 72 hours
  - CSAT where available
- **Cost (the margin unit), for each run:**
  - provider, model, and input, cached and output tokens
  - $ cost at list price
  - E2B sandbox seconds by vCPU and GiB
  - number of tool calls, retries, and wall time
  - whether a cap or ceiling was hit
- **Commercial:**
  - credit grants, burns, expiries and top-ups
  - spend-cap threshold events
  - plan changes

This data lets us re-price later, whether per resolution, per SLA met, or by value share, without a data gap.

---

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **LLM cost overrun**, for example from agent loops, long threads or Opus escalations | Enforce ceilings on each run: max tokens (e.g. 60k), max tool calls, max 3 minutes of sandbox time, and 1 retry. Route by task: Haiku for triage, Sonnet for drafts, Opus only on explicit escalation. Use prompt caching (cache reads cost 10% of input) and the batch API (−50%) for non-urgent work such as the replay and nightly reclassification. Alert internally when any workspace runs below 40% margin. |
| **Model price changes** | Fixed per-action prices, with a repricing clause on 60–90 days' notice. Keep a multi-provider abstraction (Claude/OpenAI). When prices fall, keep the savings or move the customer to a better model at the same price. |
| **Customer bill shock** | Default **hard monthly spend cap** equal to included credits plus 50%, editable by an admin. Send alerts at 50%, 80% and 100%. Show a spend forecast. Top-ups need a single click. |
| **Behavior at the cap** | Degrade gracefully: autopilot falls back to drafts, then drafts fall back to alerts only. **SLA clocks, predictions and alerts are never throttled.** Silent monitoring failure is the one outcome that destroys trust. |
| **Ticket-volume overage disputes** | Count only distinct tickets with an active SLA clock. Bill overage monthly in arrears. Offer a 10% grace buffer before charging. Suggest an auto-upgrade when it is cheaper for the customer. |
| **Help desk vendors bundle us out.** Zendesk bundles AI, reportedly bought Forethought, and Plain bundles SLAs. | Differentiate on **contract-level SLA truth** (per-customer terms, credit math and dollar exposure) and on working across help desks. Avoid pricing per seat, where the help desks set the baseline. |
| **Outcome-attribution disputes** | Bill actions rather than outcomes. Publish the definitions. Keep an audit trail for each ticket showing the clock state, the prediction and the action. |
| **Autopilot error liability** | Autopilot is Scale+ only and scoped per queue or customer, with policy controls and an instant kill switch. Limit contract liability to fees paid. Exclude autopilot from any trial. |
| **Small customers generate a high support load** | Starter is self-serve only. Its $299 floor sits just above Plain's SLA tier ($299) and Pylon's 3-seat Starter minimum. |

**Decisions to make now:**
1. Adopt the hybrid of tracked-ticket tiers plus per-action credits.
2. Build the metering schema above before general availability (GA).
3. Ship Breach Replay as the top-of-funnel.
4. Revisit the per-action prices after 30 days of real cost traces, targeting at least 60% AI margin.
