# Help-desk connector research

*As of 2026-09-29. Scope: which customer-support and help-desk platforms we can build connectors for, given two requirements: (a) a developer can get a **free** account, and (b) the platform has **good public developer documentation**.*

**How to read this.** Each claim carries one of two confidence marks:

- **[V]**: verified against a vendor page or search result during this research. The URL is cited.
- **[K]**: taken from prior knowledge of the vendor docs, with the doc URL given. Re-check it before we commit to a build.

Vendors change plan gating often, especially what the free tier includes. Treat every "free" claim as something to re-confirm on signup day.

**Free-access codes** used in the tables:

| Code | Meaning |
|---|---|
| **FREE** | Free-forever plan, or a free developer or sandbox instance that does not expire. Fully qualifies. |
| **FREE\*** | Free, but with a limit that matters for us: no API on the free tier, no webhooks, no SLA feature, an inactivity reclaim, or approval required. Qualifies with a caveat. |
| **TRIAL+** | Time-limited trial that is renewable or convertible for developers on request. Partially qualifies. |
| **TRIAL** | Time-limited trial only. Partially qualifies. |
| **PAID** | Sandbox only through a paid or partner contract. Does not qualify. |

**Difficulty score:** 1 means easy and 5 means hard. It covers auth, event delivery, how well the data fits an SLA clock, and write-back.

---

## 1. Summary table

| # | Platform | Free path | API | Auth | Webhooks | SLA data fit | Write-back | Difficulty | Tier |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Zendesk** | FREE (sponsored dev account, Suite Enterprise, 5 agents, no expiry; partner request) | REST | API token / OAuth2 | Yes, event-typed | Excellent (native SLA policies, metric events, audits) | Full | **2** | 1 |
| 2 | **Jira Service Management** | FREE (Free plan, 3 agents; free Cloud Developer site) | REST (+GraphQL) | API token / OAuth2 3LO / Forge | Yes | Excellent via SLA API, **but SLAs are reportedly not in the Free plan** | Full | **3** | 1 |
| 3 | **Intercom** | FREE (unlimited developer workspaces) | REST | Access token / OAuth2 | Yes, rich topics | Good (`statistics`, `sla_applied`, parts) | Full | **2** | 1 |
| 4 | **Freshdesk** | TRIAL+ (dev trial extendable in 90-day blocks; the hidden "free" plan has **0 API calls/min**) | REST | API key (Basic) | Via automation rules or the app platform | Excellent (`stats`, `fr_due_by`, SLA policies API) | Full | **2** | 1 |
| 5 | **HubSpot Service Hub** | FREE (developer account plus test accounts) | REST | OAuth2 public app / private-app token | Yes (tickets and conversations) | Medium (SLA props need inbox + Pro; property history) | Mostly | **3** | 1 |
| 6 | **Zammad** (OSS) | FREE (self-host with Docker; hosted trial 30d) | REST | Token / OAuth2 / Basic | Yes (trigger → webhook) | Excellent (native SLA, escalation timestamps, pending states) | Full | **2** | 2 |
| 7 | **Salesforce Service Cloud** | FREE (Developer Edition) | REST / SOAP / Pub/Sub | OAuth2 (External Client App) | CDC / Platform Events | Excellent (Entitlements, `CaseMilestone`) | Full | **4** | 2 |
| 8 | **ServiceNow** | FREE\* (Personal Developer Instance, reclaimed after about 10 days idle) | REST (Table API) | OAuth2 / Basic | Business rule / Flow → outbound REST | Excellent (`task_sla`, `sys_audit`) | Full | **4** | 2 |
| 9 | **Front** | FREE (developer account, 3 teammates) | REST | API token / OAuth2 | Yes (app webhooks, rules) | Medium (events timeline; SLA only in analytics) | Full | **3** | 2 |
| 10 | **Zoho Desk** | FREE\* (Free edition, 3 agents, 5k credits/day, **no webhooks**) | REST | OAuth2 | Paid editions only | Good (`responseDueDate`, `onholdTime`, metrics, history) | Full | **3** | 2 |
| 11 | **Linear** | FREE (Free plan, 250-issue cap, basic Issue SLAs) | GraphQL | API key / OAuth2 | Yes (incl. `IssueSLA`) | Good for internal SLAs; weak requester/agent split | Partial (no public reply) | **2** | 2 |
| 12 | **GitHub Issues** | FREE | REST + GraphQL | GitHub App / PAT | Yes | Weak (no priority/SLA natively; timeline OK) | Partial (all comments public) | **2** | 2 |
| 13 | **Gorgias** | TRIAL+ (trial converted to sandbox via support) | REST | API key / OAuth2 | Yes (HTTP integration) | Medium (SLA policies in product; API exposure unclear) | Full | **3** | 2 |
| 14 | **Help Scout** | FREE\* (Free plan has **no API**) → TRIAL for API | REST | OAuth2 | Yes, rich | Medium (thread timeline; no native SLA object) | Full | **3** | 2 |
| 15 | **Freshservice** | TRIAL+ (same Freshworks dev-trial extension) | REST | API key | Automation / app platform | Good (`fr_due_by`, `due_by`) | Full | **2** (reuses Freshdesk) | 3 |
| 16 | **Plain** | TRIAL (7 days; no free plan) | GraphQL | API key (machine users) | Yes, very rich incl. SLA transitions | Excellent | Full | **2** | 3 |
| 17 | **Crisp** | FREE (free plan + free Marketplace dev account, dev tokens) | REST + RTM | Plugin token | Yes | Weak (chat; no SLA/priority) | Partial | **3** | 3 |
| 18 | **Freshchat** | FREE\* (free tier reported; verify) | REST v2 | Bearer token | Yes | Weak–Medium | Partial | **3** | 3 |
| 19 | **Pylon** | PAID/TRIAL (demo-led; API enabled via support) | REST | API token | Yes (triggers) | Medium (unverified) | Full (low limits) | **4** | 3 |
| 20 | **Kustomer** | PAID (sandbox org on request) | REST | API key / OAuth provider | Yes | Good | Full | **4** | 3 |
| 21 | **Gladly** | PAID (sandbox bought through a CSM) | REST | Token (Basic) | Yes | Medium | Full | **5** | 3 |
| 22 | **Re:amaze** | TRIAL (14 days) | REST | API token (Basic) | Yes | Weak–Medium | Full | **3** | 3 |
| 23 | **HappyFox** | TRIAL | REST | API key + auth code | Yes (all plans) | Medium | Full | **3** | 3 |
| 24 | **LiveAgent** | FREE\* (free plan; integrations/automation off) | REST v3 | API key | Limited | Weak–Medium | Full | **3** | 3 |
| 25 | **osTicket** (OSS) | FREE (self-host) | Create-only HTTP API | API key | No (plugins) | Poor via API | Needs plugin | **5** | 3 |

---

## 2. Per-platform detail

### 2.1 Zendesk (Support / Suite): difficulty 2

- **Free path: FREE.** Start a Zendesk trial, use a subdomain prefixed with `d3v-`, then submit the Sponsored Account Request form. Marketplace partners get a sponsored instance for up to 5 agents that does not expire after 14 days, and it runs on **Suite Enterprise** by default. [V] <https://developer.zendesk.com/documentation/api-basics/getting-started/getting-a-trial-or-sponsored-account-for-development/>
- **API and auth:** REST (`/api/v2`). Auth is an API token (Basic) or OAuth2. A multi-tenant ("global") OAuth client needs Zendesk approval. [K] <https://developer.zendesk.com/api-reference/introduction/security-and-auth/>
- **Rate limits** are per account and per plan: about 200/min (Team), 400 (Growth/Professional), 700 (Enterprise), and 2,500 (Enterprise Plus / High Volume add-on). There are separate per-endpoint limits too (for example, ticket updates). [K] <https://developer.zendesk.com/api-reference/introduction/rate-limits/>
- **Webhooks:** event-subscribed webhooks, including `zen:event-type:ticket.created`, `ticket.status_changed`, `ticket.comment_added`, `ticket.priority_changed`, `ticket.agent_assignment_changed` and `ticket.tags_changed`, plus trigger-connected webhooks. [V] <https://developer.zendesk.com/api-reference/webhooks/event-types/ticket-events/>
- **SLA data (best in class):**
  - Priority is `low/normal/high/urgent`. Statuses are `new/open/pending/hold/solved/closed`; custom ticket statuses map to these categories.
  - **Ticket Audits** give every field change and comment with a timestamp and author. Comments carry `public: true/false`.
  - **Ticket Metrics** include `reply_time_in_minutes`, `requester_wait_time`, `on_hold_time` and similar.
  - The **Ticket Metric Events** API emits `activate/fulfill/pause/apply_sla/breach/update_status` per metric (`reply_time`, `requester_wait_time`, `pausable_update_time`, `periodic_update_time`, `resolution_time`, and more). `apply_sla` carries the policy target. [V] <https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_metric_events/>
  - **SLA Policies API** (`/api/v2/slas/policies`) on Professional and above. The sponsored Enterprise account includes it. [K]
- **Write-back:** public reply or internal note (`comment.public`), assignee, group, priority, tags and status, all through `PUT /tickets/{id}`. [K]
- **Caveats:** The sponsored account is a partner-program request, not self-serve. Custom ticket statuses must be mapped through `status_category`.

### 2.2 Jira Service Management: difficulty 3

- **Free path: FREE.**
  - JSM has a Free plan with up to 3 agents. [V] <https://www.eesel.ai/blog/jira-service-management-pricing>
  - A free-forever **Cloud Developer site** (<https://go.atlassian.com/cloud-dev>) includes every Jira product; JSM is limited to 1 agent there. [V] <https://developer.atlassian.com/cloud/jira/platform/getting-started-with-connect/>
- **API and auth:** Jira platform REST v3 plus the JSM REST API (`/rest/servicedeskapi`). Auth is an API token (Basic), OAuth 2.0 (3LO) or Forge. [K] <https://developer.atlassian.com/cloud/jira/service-desk/rest/>
- **Rate limits:** since **2026-03-02**, Forge, Connect and OAuth apps are metered on a points-based hourly quota. The default is a global pool of 65,000 points/hour shared across all tenants, and a per-tenant pool is available after review. Burst limits are about 100 RPS for GET and 50 RPS for PUT/DELETE, and each issue allows 20 writes per 2 s. API-token traffic is not affected. [V] <https://developer.atlassian.com/cloud/jira/platform/rate-limiting/>
- **Webhooks:** Jira webhooks (`jira:issue_created`, `jira:issue_updated`, `comment_created`, `comment_updated`). OAuth and Connect apps register dynamic webhooks, which expire after 30 days and must be refreshed. Forge offers product-event triggers. [K] <https://developer.atlassian.com/cloud/jira/platform/webhooks/>
- **SLA data:**
  - `GET /rest/servicedeskapi/request/{key}/sla` returns `ongoingCycle` (start time, breach time, paused, within calendar hours, remaining) and `completedCycles` for each SLA metric. This is the richest native SLA object after Zendesk. [K]
  - The issue changelog gives status transitions with timestamps.
  - Status categories include "Waiting for customer" and "Pending".
  - Service-desk comments carry `public` and author, so requester and agent can be told apart through JSM customer versus agent accounts.
  - **Caveat:** third-party pricing guides say **SLAs are not in the JSM Free plan** (Standard and above). [V, secondary source] <https://clearfeed.ai/blogs/jira-service-management-pricing>. Test SLA-object parsing on a Standard trial or a partner dev license, and ask Atlassian about Marketplace-partner dev licenses.
- **Write-back:** `POST /servicedeskapi/request/{key}/comment` with `public: false` posts an internal note, and `true` posts a public reply. Assignee, priority and labels go through the platform API. Comments use ADF, not plain text. [K]
- **Caveats:** ADF bodies. The two overlapping APIs (platform and servicedesk). The new points quota. The JSM rebrand into the Atlassian "Service Collection" may move doc URLs.

### 2.3 Intercom: difficulty 2

- **Free path: FREE.** Development workspaces are free, you can create as many as you want, and you do not need to be a customer. Limits: no outbound email, no phone, at most 20 users or leads, not available in the EU region, and a dev workspace cannot be converted to production. [V] <https://www.intercom.com/help/en/articles/9086429-create-a-developer-workspace-in-intercom>
- **API and auth:** REST, with versions in the header. Auth is an access token (private app) or OAuth2 (public app, through the Developer Hub). [V] <https://developers.intercom.com/docs>
- **Rate limits:** 10,000 calls/min per app and 25,000/min per workspace, spread over 10-second windows. [V] <https://developers.intercom.com/docs/references/rest-api/errors/rate-limiting>
- **Webhooks:** `conversation.user.created`, `conversation.user.replied`, `conversation.admin.replied`, `conversation.admin.noted`, `conversation.admin.assigned`, `conversation.admin.closed`, `conversation.admin.snoozed`, `ticket.created`, `ticket.state.updated`, and more. Conversation topics **do not fire for tickets**, so we must subscribe to both families. [V] <https://developers.intercom.com/docs/references/webhooks/webhook-models>
- **SLA data:**
  - Conversation `statistics` include `first_contact_reply_at`, `first_admin_reply_at`, `last_close_at`, `time_to_admin_reply` and `count_reopens`.
  - `sla_applied` carries `sla_name` and `sla_status` (hit/missed/active/cancelled).
  - Conversation parts are typed (`comment`, `note`, `assignment`, `open`, `close`, `snoozed`) and have an author type (`user/admin/bot`).
  - Ticket states: submitted, in_progress, waiting_on_customer, resolved.
  - `priority` is only binary (priority / not_priority).

  [K] <https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations>
- **Write-back:** reply (comment or note), assign, tag, snooze, close, set priority, and update ticket state. [K]
- **Caveats:** Priority is binary. Whether SLA features are enabled in dev workspaces is unverified. Tickets and conversations are two object models.

### 2.4 Freshdesk: difficulty 2

- **Free path: TRIAL+.**
  - The Freshworks Developer Portal enrols you in a product trial, and developers can extend it **up to 90 days at a time, repeatedly**, through the Assist portal. [V] <https://community.freshworks.dev/t/how-to-create-and-extend-a-developer-account/316>
  - The residual "Free" plan (2 agents, 6 months, not advertised) has an **API rate limit of 0/min**. Trials get 50/min. [V] <https://support.freshdesk.com/support/solutions/articles/225439-what-are-the-rate-limits-for-the-api-calls-to-freshdesk-> · <https://www.eesel.ai/blog/freshdesk-free-plan>
- **API and auth:** REST v2 with an API key as Basic auth. There is no OAuth for the REST API; marketplace apps use the Freshworks app platform with install parameters (iparams). [K] <https://developers.freshdesk.com/api/>
- **Rate limits:** Growth 200/min, Pro 400/min, Enterprise 700/min, with per-endpoint sub-limits. [V] (same support article)
- **Webhooks:** configured through **Automation rules** (ticket creation or update) in the admin UI, not by API. Marketplace apps can subscribe to product events (`onTicketCreate`, `onTicketUpdate`, `onConversationCreate`) on the serverless platform. [K]
- **SLA data:**
  - `?include=stats` returns `first_responded_at`, `agent_responded_at`, `requester_responded_at`, `pending_since`, `status_updated_at`, `resolved_at` and `closed_at`. [V] <https://community.freshworks.dev/t/freshdesk-api-get-what-parameter-should-i-use-to-get-value/11652>
  - Tickets carry `fr_due_by`, `due_by`, `nr_due_by`, `fr_escalated` and `is_escalated`.
  - Statuses: Open, Pending, Resolved, Closed, Waiting on Customer, Waiting on Third Party. Custom statuses have an "SLA timer on/off" flag.
  - SLA Policies API: `/api/v2/sla_policies`.
  - Conversations carry `incoming` (requester or agent) and `private`.

  [K]
- **Write-back:** reply, note (`private`), assignee, group, priority, tags and status. [K]
- **Caveats:** The data has quirks, for example `first_responded_at` earlier than `created_at` has been reported. [V] <https://community.freshworks.com/api-and-webhooks-11406/inconsistent-data-api-tickets-first-responded-at-field-has-a-date-before-created-at-43605>. Webhooks are set up per account in the UI, so plan for a guided setup or ship an app.

### 2.5 HubSpot Service Hub: difficulty 3

- **Free path: FREE.** A free developer account can create up to 10 **developer test accounts**. These are free, with a 90-day trial of many Enterprise features. [V] <https://developers.hubspot.com/docs/getting-started/account-types>
- **API and auth:** REST (CRM v3/v4). Auth is an OAuth2 public app or a private-app / static token. [K]
- **Rate limits:** about 100–190 requests per 10 s depending on tier and app type, plus daily caps for private apps. [K] <https://developers.hubspot.com/docs/guides/apps/api-usage/usage-details>
- **Webhooks:** the Webhooks v3 API supports Tickets (`0-5`) and Conversations (`0-11`) with CREATE, UPDATE, DELETE, MERGE and association events. It is partly beta. [V] <https://developers.hubspot.com/docs/api-reference/webhooks-webhooks-v3/guide>
- **SLA data:**
  - Status is a pipeline stage (`hs_pipeline_stage`) plus `hs_ticket_priority`.
  - `propertiesWithHistory` gives transitions with timestamps.
  - SLA properties (Time to First Response SLA Due Date and Status, Time to Close SLA Due Date and Status) exist only when SLAs are configured in the help desk or inbox, which is a Pro feature. [V] <https://knowledge.hubspot.com/properties/hubspots-default-ticket-properties>
  - Requester and agent messages live in the **Conversations** API (threads and messages), not on the ticket.
- **Write-back:** internal note through the Notes engagement associated with the ticket. A public reply goes through the Conversations "send message" call on the linked thread. Owner and priority are properties. [K]
- **Caveats:** "Pending" is a custom pipeline stage, so each customer needs a mapping step. The SLA properties need a paid tier plus the inbox. Two data models (ticket and thread) must be joined.

### 2.6 Zammad (open source): difficulty 2

- **Free path: FREE.** Self-host it (Docker Compose, AGPL). A hosted trial is also available. This makes it an ideal **CI and integration-test fixture**. [K] <https://docs.zammad.org/en/latest/api/intro.html>
- **API and auth:** REST (plus GraphQL used by the new UI). Auth is a token, OAuth2 or Basic. A self-hosted instance has no rate limit by default. [V] <https://docs.zammad.org/en/latest/api/intro.html>
- **Webhooks:** Triggers (ticket create or update, with conditions) → Webhook, with a customizable payload. [K] <https://admin-docs.zammad.org/en/latest/manage/webhook.html>
- **SLA data:**
  - A native SLA object: `GET /api/v1/slas`. [V] <https://docs.zammad.org/en/latest/api/sla.html>
  - Tickets carry `first_response_at`, `first_response_escalation_at`, `update_escalation_at`, `close_escalation_at` and `escalation_at`.
  - States: new, open, pending reminder, pending close, closed, merged. Pending states freeze the SLA. [V] <https://admin-docs.zammad.org/en/latest/manage/slas.html>
  - Articles carry `sender` (Customer/Agent/System) and `internal`.
  - A ticket history endpoint is available.
- **Write-back:** article with `internal: true` (note) or an email article (public reply), owner, priority and tags. [K]
- **Caveats:** A smaller market, but it is the cheapest way to test SLA semantics end to end.

### 2.7 Salesforce Service Cloud: difficulty 4

- **Free path: FREE.** Developer Edition is free and does not expire while in use. Since April 2026 it includes Agentforce and MCP. [V] <https://developer.salesforce.com/blogs/2026/04/new-developer-edition-agentforce-vibes-claude-mcp>
  - Entitlement processes are allowed (up to 1,000 processes, 10 milestones each). [V] <https://help.salesforce.com/s/articleView?id=xcloud.overview_limits_developer.htm&language=en_US&type=5>
- **API and auth:** REST, SOAP, Bulk and the Pub/Sub API. Auth is OAuth2 through an **External Client App**. From Spring '26, customers **can no longer create new Connected Apps** without Support; existing and packaged ones keep working. [V] <https://help.salesforce.com/s/articleView?id=005228017&language=en_US&type=1>
- **Rate limits:** a 24-hour rolling API allocation, about 15,000/day on Developer Edition. [K]
- **Events:** Change Data Capture on `Case`, Platform Events, and the Pub/Sub API (gRPC). Outbound messages and Flows are alternatives. [K]
- **SLA data:**
  - `Case.Status`/`Priority`, `CaseHistory` (needs field history tracking), and `CaseMilestone` (`TargetDate`, `CompletionDate`, `IsViolated`, `IsCompleted`) from Entitlements.
  - `CaseComment.IsPublished` for public or internal comments, and `EmailMessage.Incoming`.
- **Write-back:** CaseComment (published or not), EmailMessage send, OwnerId, Priority and topics. [K]
- **Caveats:** Heavy per-org configuration (entitlement setup, history tracking), CDC channel entitlements, the External Client App migration, and AppExchange security review for distribution.

### 2.8 ServiceNow: difficulty 4

- **Free path: FREE\*.** A **Personal Developer Instance** is free, but it is reclaimed after about 10 days with no logins. [V] <https://developer.servicenow.com/blog.do?p=%2Fpost%2Fdeveloper-instance-tips%2F>
- **API and auth:** REST Table API (`/api/now/table/incident`, `task_sla`, `sys_journal_field`, `sys_audit`). Auth is OAuth2 or Basic. Rate-limit rules are set by the instance admin. [V] <https://thesnowball.co/table/task_sla>
- **Events:** no generic webhook product. Use a Business Rule or Flow Designer → Outbound REST Message, or poll with `sys_updated_on`. [K]
- **SLA data:** `task_sla` records hold `stage`, `has_breached`, `planned_end_time`, `pause_time` and `business_percentage`. `incident.state` includes "On Hold" with `hold_reason` (for example Awaiting Caller). Journal entries are `comments` (customer-visible) or `work_notes` (internal). [V/K]
- **Write-back:** `comments` or `work_notes`, `assigned_to`, `priority` (derived from impact × urgency) and `state`. [K]
- **Caveats:** Pushing events needs a customer-installed scoped app or update set. Distributing through the ServiceNow Store requires partner certification. The PDI reclaim policy breaks long-lived test fixtures.

### 2.9 Front: difficulty 3

- **Free path: FREE.** A free developer account on the Developer Portal, limited to 3 teammates. [V] <https://dev.frontapp.com/docs/welcome>
- **API and auth:** Core API (REST). Auth is an API token or OAuth2 (partner apps). [K]
- **Rate limits:** Starter 50/min, Professional 100/min, Enterprise 200/min, enforced per company. There is also a limit of 5 requests/s per resource. [V] <https://dev.frontapp.com/docs/rate-limiting>
- **Webhooks:** app webhooks and rule-based webhooks. Event types include inbound, outbound, comment, assign, tag, archive and reopen. [K]
- **SLA data:** the Events API gives a timeline. Messages carry `is_inbound`, and comments are internal. Ticketing statuses have categories (open, waiting, resolved). SLA rules exist in the product, but SLA metrics are **only available through Analytics**; there is no SLA object. [V] <https://www.getmacha.com/blog/front-api-explained>
- **Write-back:** comment (internal), reply (message), assign, tag and status. [K]
- **Caveats:** A conversation-centric model with no priority field (tags or custom fields instead). The per-company rate limit is low.

### 2.10 Zoho Desk: difficulty 3

- **Free path: FREE\*.** The Free edition has 3 agents, 5,000 API credits/day, a **"Default" SLA only**, and **no webhooks or workflows**. [V] <https://www.zoho.com/desk/pricing-comparison.html>
- **API and auth:** REST with OAuth2 (Zoho Accounts, data-center specific). Credits reset every 24 hours. [V] <https://desk.zoho.com/DeskAPIDocument>
- **Webhooks:** events such as `Ticket_Add`, `Ticket_Update`, `Ticket_Thread_Add` and `Ticket_Comment_Add` on paid editions. On Free, poll instead. [V/K] <https://desk.zoho.eu/support/WebhookDocument.do>
- **SLA data:** `responseDueDate`, `dueDate`, `onholdTime`, `customerResponseTime` and `statusType` (Open/On Hold/Closed). The metrics endpoint gives `firstResponseTime`, `responseCount` and `stagingData`. Ticket history is available. Thread direction is in or out; comments are public or private. [V] <https://truto.one/integrations/detail/zohodesk/>
- **Write-back:** sendReply, comment (`isPublic`), assignee, priority and tags. [K]
- **Caveats:** Multi-data-center base URLs (.com/.eu/.in/.com.au/.jp) and credit accounting.

### 2.11 Linear: difficulty 2

- **Free path: FREE.** The Free plan has unlimited members, 2 teams, **250 issues**, and basic Issue SLAs. [V] <https://linear.app/pricing>
- **API and auth:** GraphQL. Auth is a personal API key or OAuth2 (including `actor=app`). Rate limits are complexity-based: 3M points/hour for an API key, 2M/hour for OAuth, and at most 10k per query. [V] <https://linear.app/developers/rate-limiting>
- **Webhooks:** Issue, Comment, IssueLabel, Project and **IssueSLA**, among others. [V] <https://inventivehq.com/blog/linear-webhooks-guide>
- **SLA data:** `slaStartedAt`, `slaMediumRiskAt`, `slaHighRiskAt`, `slaBreachesAt` and `slaType` on Issue. Priority runs 0–4. State types are triage, backlog, unstarted, started, completed and canceled. IssueHistory gives transitions. **There is no native requester/agent split**, except through Customer Requests / Asks. [K]
- **Write-back:** comment, assignee, priority and labels. There is **no public-vs-internal distinction**. [K]
- **Caveats:** Linear is an engineering tracker rather than a help desk. It is useful for escalated-ticket SLAs.

### 2.12 GitHub Issues: difficulty 2

- **Free path: FREE.** Docs: [K] <https://docs.github.com/en/rest>
- **API and auth:** REST and GraphQL. Auth is a GitHub App (recommended) or a PAT. Rate limit is 5,000/hour per installation, scaling up to 12,500. [K] <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- **Webhooks:** `issues` (opened, closed, reopened, assigned, labeled, and so on) and `issue_comment`. [K]
- **SLA data:** only open and closed, with `state_reason`. Priority and pending states come from labels, issue types or issue fields. The timeline events API gives timestamps. `author_association` separates maintainers from outside reporters. There is no SLA object. [K]
- **Write-back:** comments (always public), assignees and labels. [K]
- **Caveats:** A useful "OSS support" connector, but the SLA semantics must be configured per repo.

### 2.13 Gorgias: difficulty 3

- **Free path: TRIAL+.** Create a trial, then email support@gorgias.io to convert it into a sandbox. [V] <https://developers.gorgias.com/reference/limitations>
- **API and auth:** REST. OAuth2 is required for App Store listing. An API key (Basic) also works. [V] <https://developers.gorgias.com/docs/building-a-high-quality-gorgias-app>
- **Rate limits:** OAuth 80 requests per 20 s, API key 40 per 20 s (leaky bucket). [V] (same limitations page)
- **Webhooks:** HTTP integration triggers: ticket created, ticket updated, ticket message created. [V] <https://www.ringly.io/blog/gorgias-webhooks-documentation>
- **SLA data:** SLA policies (first response and resolution) exist in the product. [V] <https://docs.gorgias.com/en-US/sla-policies-536784>. Whether they are exposed through the API is **unverified**. Statuses are open and closed, plus snooze. Messages carry `from_agent` and internal-note channels.
- **Write-back:** message (public), internal note, assignee, tags and priority. [K]

### 2.14 Help Scout: difficulty 3

- **Free path: FREE\* → TRIAL.** The Free plan (5 users, 100 contacts/month) has **no API access**; the API starts on Standard. [V] <https://www.eesel.ai/blog/helpscout-api> · <https://docs.helpscout.com/article/1597-free-plan>. Use a paid trial, or ask the partner program. [V] <https://www.helpscout.com/partner/>
- **API and auth:** Inbox (Mailbox) API 2.0, REST, OAuth2 (authorization code or client credentials).
- **Rate limits:** 200/min (Standard), 400 (Plus), 800 (Pro). Writes count as 2. [V] <https://developer.helpscout.com/mailbox-api/overview/rate-limiting/>
- **Webhooks:** `convo.created`, `convo.status`, `convo.assigned`, `convo.customer.reply.created`, `convo.agent.reply.created`, `convo.note.created`, `convo.tags`, and more. [V] <https://developer.helpscout.com/webhooks/>
- **SLA data:** statuses are active, pending, closed and spam, plus snooze. Thread types are customer, reply, note and lineitem; lineitems record status and assignment changes with timestamps. **There is no priority field and no native SLA object.** [K]
- **Write-back:** reply, note, assign and tags. [K]

### 2.15 Freshservice: difficulty 2 (shares the Freshdesk code path)

- **Free path: TRIAL+.** There is no permanent free plan, only a 14-day trial. [V] <https://www.getmacha.com/blog/freshservice-pricing-explained>. It can be extended through the same Freshworks developer process. [V] <https://community.freshworks.dev/t/how-to-create-and-extend-a-developer-account/316>
- **API and auth:** REST v2 with an API key. Rate limits are per plan. [V] <https://support.freshservice.com/support/solutions/articles/50000000293-what-is-the-rate-limit-for-apis-across-all-plans->
- **SLA data:** `fr_due_by` and `due_by`. Statuses are Open, Pending, Resolved and Closed. Conversations carry private and incoming flags. Webhooks come through workflow automator. [K]

### 2.16 Plain: difficulty 2 (Tier 3 only because there is no free path)

- **Free path: TRIAL.** 7 days; plans start at $35. [V] <https://www.plain.com/pricing>
- **API:** GraphQL with an API key and a published schema. Rate limits are described as generous. [V] <https://www.plain.com/blog/api-first-support-platforms>
- **Webhooks:** more than 20 event types, including thread created, status transitions, assignment, priority, labels and **SLA status transitions**. At-least-once delivery with 12 retries over about 5 days. [V] (same source)
- **SLA data:** status TODO, SNOOZED or DONE with status detail (for example waiting for customer), priority 0–3, native SLAs, a timeline, and notes versus replies. [K]
- **Next step:** ask Plain for a partner or dev workspace. This would be the easiest connector to build if they grant one.

### 2.17 Crisp: difficulty 3

- **Free path: FREE.** A free plan plus a free Marketplace account. **Development tokens** can use every plugin route but have lower quotas. [V] <https://docs.crisp.chat/guides/rest-api/authentication/plugin-token/>
- **Rate limits:** a plugin quota of 5,000 requests/day by default, which can be raised. [V] <https://docs.crisp.chat/guides/rest-api/rate-limits/>
- **Events:** Web Hooks and Plugin Hooks (signed, with retries), plus RTM websockets. [V] <https://docs.crisp.chat/references/web-hooks/v1/>
- **SLA data:** conversation state is pending, unresolved or resolved. Messages carry `from: user|operator`, and notes are a message type. **There is no priority and no SLA object.** [K]

### 2.18 Freshchat: difficulty 3

- **Free path: FREE\*.** A free tier is reported (a third-party review says up to 10 agents). Re-verify it, because Freshworks has been moving Freshchat into Freshdesk Omni. [V, secondary] <https://chatimize.com/reviews/freshchat/>
- **API and auth:** REST v2 with an agent-scoped bearer token.
- **Webhooks:** `message_create`, `conversation_assignment`, `conversation_resolution` and `conversation_reopen`. [V] <https://crmsupport.freshworks.com/support/solutions/articles/50000004461-freshchat-webhooks-payload-structure-and-authentication>
- **SLA data:** status is new, assigned, resolved or reopened. Messages carry actor_type (user, agent or bot) and private notes. SLA support is minimal. [K]

### 2.19 Pylon: difficulty 4

- **Free path: PAID or TRIAL.** Access is demo-led, and API access is enabled by contacting support. [V] <https://docs.usepylon.com/pylon-docs/developer/api>
- **API and auth:** REST with an API token.
- **Rate limits** are per endpoint and **low**: list issues 30/min, reply 10/min, internal note 10/min. [V] <https://docs.usepylon.com/pylon-docs/developer/api/api-reference/issues>
- **Webhooks:** through triggers.
- **SLA data:** issue states include new, waiting on you, waiting on customer, on hold and closed. SLA features exist in the product, but their exposure through the API is unverified. [K]

### 2.20 Kustomer: difficulty 4

- **Free path: PAID.** Sandbox or test orgs are available **on request** (email Kustomer). [V] <https://developer.kustomer.com/kustomer-apps-platform/docs/getting-started-with-kustomer>
- **API and auth:** REST with role-scoped API keys, plus an OAuth provider for apps. Webhooks come through hooks and workflows. Conversations carry SLA fields in the product. [K]

### 2.21 Gladly: difficulty 5

- **Free path: PAID.** The API is enabled in a sandbox (`{org}.gladly.qa`) that customers **buy through their CSM**. [V] <https://developer.gladly.com/rest/>
- **API and auth:** REST with a token as Basic auth. Webhooks exist. Access is the blocker, not the documentation.

### 2.22 Re:amaze: difficulty 3

- **Free path: TRIAL** (14 days). [V] <https://support.reamaze.com/kb/plan-settings/reamaze-free-trial-policy>
- **API and auth:** REST with a Basic API token. Rate limited per token per minute, returning 429. Webhooks exist. [V] <https://www.reamaze.com/api>
- **SLA data:** weak.

### 2.23 HappyFox: difficulty 3

- **Free path: TRIAL** or demo.
- **API and auth:** REST with an API key plus an auth code as Basic auth.
- **Webhooks:** available on all plans for ticket create and edit, and from smart rules. [V] <https://support.happyfox.com/kb/article/128-create-and-manage-webhooks/>
- **SLA data:** the product has SLAs; exposure through the API is unverified.

### 2.24 LiveAgent: difficulty 3

- **Free path: FREE\*.** A free plan exists, but ticket messages older than 7 days are hidden, and integrations and automation are off. [V] <https://www.liveagent.com/free-plan/>
- **API and auth:** REST v3 with an API key. Rate limit is 180/min per key. [V] <https://support.liveagent.com/931802-API-rate-limit-API-requests-limit>
- **SLA data:** has SLA levels; API exposure is unverified.

### 2.25 osTicket (open source): difficulty 5

- **Free path: FREE** (self-host).
- **API:** the stock API only **creates** tickets. Listing, replying and updating need third-party plugins (for example osticket-api-plus). [V] <https://github.com/osTicket/osTicket/wiki/osTicket-API> · <https://github.com/HairyDuck/osticket-api-plus>
- **Recommendation:** do not build this. Point osTicket users at Zammad instead.

---

## 3. Ranked build order

**Ranking criteria, in order:** free and long-lived dev access, then SLA data richness, then market reach in B2B support, then write-back completeness, then effort.

### Tier 1: build first

1. **Zendesk.** The reference implementation. It has the richest SLA primitives (metric events, SLA policies, audits) and typed webhooks, and a sponsored account gives an Enterprise sandbox that does not expire. Build the canonical model against it.
2. **Jira Service Management.** Free plan and dev site, plus the native SLA cycle API. Budget for ADF, the points quota and dynamic-webhook refresh. The SLA-object tests need a Standard trial or dev license.
3. **Intercom.** Free, unlimited dev workspaces, generous limits, and rich topics plus `sla_applied`. Handle the conversation/ticket split.
4. **Freshdesk.** Excellent SLA fields and a large SMB base. Dev access is an extendable trial rather than free-forever. Freshservice comes almost free on the same code path.
5. **HubSpot Service Hub.** Free dev and test accounts and a large install base. Needs a mapping UI for pipeline stages, and SLA properties exist only on Pro or with the inbox.

### Tier 2: build next

6. **Zammad.** Stand it up in Docker as our **SLA conformance test fixture** early, even before it ships as a product connector.
7. **Salesforce Service Cloud.** Free Developer Edition and gold-standard milestones, but high setup and distribution cost.
8. **ServiceNow.** Free PDI and `task_sla`, but events need a customer-installed app and the PDI is reclaimed.
9. **Zoho Desk.** Free edition, but no webhooks on Free, so the connector must support polling.
10. **Front.** Free dev account; SLA only through analytics.
11. **Gorgias.** Sandbox by request; e-commerce support segment.
12. **Help Scout.** Good API and webhooks, but no free API. Needs a trial or partner access.
13. **Linear** and 14. **GitHub Issues.** Free and easy, but not help desks. Position them as escalation targets (engineering-side SLA), not primary queues.

### Tier 3: opportunistic, or blocked on access

15. Freshservice (a follow-on to Freshdesk). 16. Plain (build if they grant a dev workspace; technically the easiest). 17. Crisp. 18. Freshchat. 19. Pylon. 20. Kustomer. 21. Re:amaze. 22. HappyFox. 23. LiveAgent. 24. Gladly. 25. osTicket (skip).

---

## 4. Canonical ticket event model

Every connector normalizes source payloads into one append-only event stream. The SLA engine consumes **only** canonical events. A native SLA object, where one exists, is carried alongside as a cross-check (`native_sla`), never as the source of truth.

### 4.1 Envelope

```jsonc
{
  "event_id": "uuidv7",                 // ours
  "idempotency_key": "zendesk:acme:audit:123456:2", // source-derived, dedupes webhook + poll
  "connector": "zendesk",               // zendesk|jsm|intercom|freshdesk|hubspot|zammad|salesforce|servicenow|front|zoho_desk|...
  "tenant_id": "our-customer-id",
  "source_account": "acme.zendesk.com",
  "ticket_ref": { "source_id": "12345", "display_key": "#12345", "url": "https://..." },
  "type": "ticket.status_changed",      // see 4.2
  "occurred_at": "2026-09-29T14:02:11Z",// SOURCE timestamp; the SLA clock uses this, never received_at
  "received_at": "2026-09-29T14:02:13Z",
  "delivery": "webhook",                // webhook|poll|backfill|stream
  "source_seq": "audit:123456",         // monotonic per ticket when available (audit id, changelog id, part id)
  "actor": { "role": "agent", "source_id": "u_9", "display": "Dana", "is_bot": false },
  "change": { "field": "status", "from": "open", "to": "pending" },
  "comment": null,                      // populated for comment.* events
  "snapshot": { /* 4.3, ticket state AFTER the event */ },
  "native_sla": null,                   // 4.5, passthrough when the platform has one
  "raw_ref": "s3://.../zendesk/acme/12345/audit-123456.json"
}
```

### 4.2 Event types

| Type | Emitted when | SLA relevance |
|---|---|---|
| `ticket.created` | new ticket or request | starts first-response and resolution clocks |
| `ticket.status_changed` | any status move (`change.from/to` as canonical `status_category`, raw status kept) | pause and resume, stop, reopen |
| `ticket.priority_changed` | priority set or changed | re-targets clocks |
| `ticket.assignee_changed` | agent or group assignment | ownership metrics, routing SLAs |
| `ticket.tags_changed` | tags or labels added or removed | policy matching (for example VIP) |
| `ticket.field_changed` | other mapped custom field (type, product, tier) | policy matching |
| `comment.created` | any message, reply or note | first public agent reply; requester reply restarts next-reply clock |
| `comment.updated` / `comment.deleted` | edit or redaction | audit only |
| `ticket.merged` / `ticket.deleted` / `ticket.restored` | lifecycle | close or void clocks |
| `sla.native_event` | platform SLA applied, paused, fulfilled or breached (Zendesk metric events, JSM cycles, Intercom `sla_applied`, Linear `IssueSLA`, Plain SLA transitions, Zammad escalation) | reconciliation only |

### 4.3 Snapshot (normalized ticket)

```jsonc
{
  "subject": "…",
  "status_raw": "Waiting on Customer",
  "status_category": "pending",         // new | open | pending | on_hold | solved | closed
  "priority": "high",                   // urgent | high | normal | low | none
  "priority_raw": "P2",
  "channel": "email",                   // email|chat|web|api|phone|social|slack|other
  "requester": { "source_id": "c_1", "email": "…", "org_id": "…" },
  "assignee": { "source_id": "u_9" }, "group": { "source_id": "g_2" },
  "tags": ["vip"], "custom": { "tier": "enterprise" },
  "created_at": "…", "updated_at": "…", "solved_at": null, "closed_at": null,
  "first_public_agent_reply_at": "…",   // derived by US from comment.created, never trusted from the source
  "last_requester_message_at": "…", "last_public_agent_reply_at": "…"
}
```

**Status category semantics.** These drive clock pause and stop; each connector ships a default mapping that the customer can override.

| Category | Meaning | Default clock behaviour |
|---|---|---|
| `new` | not yet touched | running |
| `open` | with support | running |
| `pending` | waiting on requester | first-response and next-reply paused; resolution configurable |
| `on_hold` | waiting on a third party or internal team | configurable (paused for customer-facing SLA) |
| `solved` | resolved, may reopen | stopped; reopen resumes |
| `closed` | terminal | stopped |

Default mappings:

- **Zendesk:** new/open/pending/hold/solved/closed, one to one.
- **JSM:** status category plus a name map ("Waiting for customer" → pending).
- **Intercom:** submitted → new, in_progress → open, waiting_on_customer → pending, resolved → solved. Snoozed conversations → pending.
- **Freshdesk:** 2 → open, 3 → pending, 6 → pending, 7 → on_hold, 4 → solved, 5 → closed. Custom statuses use their SLA-timer flag.
- **HubSpot:** a per-pipeline-stage mapping (required), with ticket_state CLOSED → closed.
- **Zammad:** pending reminder/close → pending.
- **ServiceNow:** On Hold with Awaiting Caller → pending, other hold reasons → on_hold, Resolved → solved.
- **Salesforce:** a Case Status picklist map, with IsClosed.
- **Front and Help Scout:** open/active → open, waiting/pending/snoozed → pending, resolved/closed → solved.
- **GitHub:** open/closed plus label rules.

### 4.4 Comment

```jsonc
{
  "source_id": "c_789",
  "author_role": "requester",   // requester | agent | end_user_other (CC/collaborator) | bot | system
  "visibility": "public",       // public | internal
  "channel": "email",
  "body_text": "…", "body_html": "…", "has_attachments": false
}
```

Rules for `author_role` and `visibility`, per connector:

- **Zendesk:** `author_id` role + `public`.
- **JSM:** servicedesk `public` + whether the author is a portal customer.
- **Intercom:** `author.type` (`user`/`lead` → requester, `admin` → agent, `bot` → bot); `part_type: note` → internal.
- **Freshdesk:** `incoming` + `private`.
- **HubSpot:** conversation message `senders` actor type, and Notes → internal.
- **Zammad:** `sender` + `internal`.
- **Salesforce:** EmailMessage.Incoming, and CaseComment.IsPublished.
- **ServiceNow:** `comments` → public, `work_notes` → internal; author is the caller or another user.
- **Front:** message `is_inbound`, and comments → internal.
- **Help Scout:** thread type.
- **GitHub:** `author_association` (MEMBER/OWNER/COLLABORATOR → agent).
- **Linear:** everything is internal unless it comes from a Customer Request or external user.

**First public agent reply** is the earliest `comment.created` event with `author_role = agent`, `visibility = public`, and `is_bot = false` (bots are configurable per tenant). We compute it ourselves. The source value is kept only for reconciliation, because vendors disagree on whether auto-replies, macros or ticket creation by an agent count, and Freshdesk has known timestamp anomalies.

### 4.5 Native SLA passthrough (optional)

```jsonc
{
  "policy_id": "sla_42", "policy_name": "Enterprise P1",
  "metric": "first_reply",          // first_reply | next_reply | resolution | periodic_update | custom
  "state": "active",                // active | paused | fulfilled | breached | cancelled
  "target_at": "…", "breached_at": null, "business_hours": true,
  "source": "zendesk.ticket_metric_event"
}
```

### 4.6 Write-back commands (the connector interface)

- `post_comment(ticket, body, visibility)`
- `set_assignee(ticket, agent|group)`
- `set_priority(ticket, canonical_priority)`
- `add_tags` / `remove_tags(ticket, tags)`
- `set_status(ticket, status_category | raw)`

Each connector declares a capability matrix; for example `github.post_comment.internal = unsupported` and `linear.post_comment.public = unsupported`. The platform degrades gracefully, for example by falling back to an internal tag.

### 4.7 Ingestion rules (all connectors)

1. **Webhook plus reconciliation poll.** A webhook provides low latency, and a periodic incremental poll (for example Zendesk incremental export, JSM JQL `updated >=`, Freshdesk `updated_since`, or HubSpot search by `hs_lastmodifieddate`) backfills missed deliveries. Deduplicate on `idempotency_key`.
2. **Order by `occurred_at`, then `source_seq`,** never by arrival time. Recompute the SLA state when a late event arrives.
3. **Derive transitions from history APIs** (Zendesk audits, Jira changelog, HubSpot `propertiesWithHistory`, Zoho history, `sys_audit`, Linear IssueHistory, the GitHub timeline) when webhooks carry only the post-change snapshot.
4. **Store the raw payload** (`raw_ref`) so the model can be re-normalized when mappings change.
5. **Keep a per-connector rate-limit governor.** Budgets are Front 50/min per company, Pylon 10/min for writes, Jira points, Zoho daily credits and Salesforce's 24-hour allocation.

---

## 5. Key caveats

- **"Free" usually means a partner or dev arrangement, not a self-serve free plan.**
  - Zendesk's non-expiring account is a sponsored-account request.
  - Freshdesk and Freshservice are extendable trials. Freshdesk's free tier has **0 API calls/min**.
  - Gorgias converts a trial to a sandbox on request.
  - Kustomer, Gladly and Pylon require a contract or contact.
- **Free tiers often lack exactly what an SLA product needs.**
  - JSM Free reportedly has no SLAs.
  - Zoho Desk Free has no webhooks and only the default SLA.
  - Help Scout Free has no API.
  - HubSpot SLA properties need Pro plus the inbox.
  - Intercom dev workspaces have no email.
- **Platform auth changes:** Salesforce blocked new Connected App creation from Spring '26 (use External Client Apps). Atlassian moved apps to points-based quotas on 2026-03-02.
- **Long-lived fixtures:** a ServiceNow PDI is reclaimed after about 10 idle days, and HubSpot test accounts carry a 90-day Enterprise trial. Automate re-provisioning, and use self-hosted Zammad for stable CI.
- **Never trust vendor "first response" fields as the source of truth.** Definitions differ between vendors. Derive the value from canonical comment events.
- **Items marked [K]** (for example the Zendesk per-plan rate numbers, HubSpot per-tier limits and Salesforce Developer Edition API allocation) should be re-verified before implementation begins.
