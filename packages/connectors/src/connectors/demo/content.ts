/**
 * Content catalogue for the demo help desk. Companies and people are fictional
 * (reserved-looking domains), so nothing here resembles a real customer.
 */
import type { Priority } from "@slai/sla-engine";

export interface DemoOrg {
  id: string;
  name: string;
  domain: string;
  plan: "enterprise" | "growth" | "starter";
}

export const ORGS: DemoOrg[] = [
  { id: "org-northwind", name: "Northwind Analytics", domain: "northwind-analytics.example", plan: "enterprise" },
  { id: "org-bluepeak", name: "Bluepeak Logistics", domain: "bluepeak.example", plan: "enterprise" },
  { id: "org-quillon", name: "Quillon Health", domain: "quillon-health.example", plan: "enterprise" },
  { id: "org-harbor", name: "Harbor & Finch", domain: "harborfinch.example", plan: "growth" },
  { id: "org-meridian", name: "Meridian Payments", domain: "meridianpay.example", plan: "enterprise" },
  { id: "org-tessel", name: "Tessel Robotics", domain: "tessel.example", plan: "growth" },
  { id: "org-oakridge", name: "Oakridge Learning", domain: "oakridge-learning.example", plan: "growth" },
  { id: "org-lumen", name: "Lumen Retail Group", domain: "lumenretail.example", plan: "enterprise" },
  { id: "org-cobalt", name: "Cobalt Insurance", domain: "cobalt-ins.example", plan: "enterprise" },
  { id: "org-sprout", name: "Sprout Studio", domain: "sproutstudio.example", plan: "starter" },
  { id: "org-vantage", name: "Vantage Freight", domain: "vantagefreight.example", plan: "growth" },
  { id: "org-kestrel", name: "Kestrel Energy", domain: "kestrel-energy.example", plan: "enterprise" },
  { id: "org-pinecone", name: "Pinecone Labs", domain: "pineconelabs.example", plan: "starter" },
  { id: "org-arcadia", name: "Arcadia Travel", domain: "arcadiatravel.example", plan: "growth" },
  { id: "org-ironwood", name: "Ironwood Legal", domain: "ironwood-legal.example", plan: "growth" },
  { id: "org-solstice", name: "Solstice Media", domain: "solstice-media.example", plan: "starter" },
];

export const FIRST_NAMES = [
  "Maya",
  "Liam",
  "Priya",
  "Noah",
  "Sofia",
  "Ethan",
  "Aisha",
  "Lucas",
  "Hana",
  "Omar",
  "Chloe",
  "Mateo",
  "Grace",
  "Kenji",
  "Zara",
  "Daniel",
  "Elena",
  "Samuel",
  "Ines",
  "Tomás",
];
export const LAST_NAMES = [
  "Chen",
  "Okafor",
  "Patel",
  "Novak",
  "García",
  "Kim",
  "Johansson",
  "Haddad",
  "Rossi",
  "Nguyen",
  "Schmidt",
  "Mensah",
  "Silva",
  "Kowalski",
  "Ibrahim",
  "Moreau",
  "Tanaka",
  "Walsh",
  "Costa",
  "Levi",
];

export interface DemoAgent {
  id: string;
  name: string;
}

export const AGENTS: DemoAgent[] = [
  { id: "agent-dana", name: "Dana Whitfield" },
  { id: "agent-rahul", name: "Rahul Mehta" },
  { id: "agent-sam", name: "Sam O'Connell" },
  { id: "agent-lena", name: "Lena Fischer" },
  { id: "agent-marco", name: "Marco Bianchi" },
  { id: "agent-yuki", name: "Yuki Sato" },
];

export const BOT = { id: "bot-autoreply", name: "Support Bot" };

export interface Category {
  key: string;
  weight: number;
  /** Priority weights: urgent, high, normal, low, none. */
  priorities: [number, number, number, number, number];
  subjects: string[];
  bodies: string[];
  followUps: string[];
  asks: string[];
  resolutions: string[];
  notes: string[];
}

export const CATEGORIES: Category[] = [
  {
    key: "login_sso",
    weight: 18,
    priorities: [10, 35, 45, 5, 5],
    subjects: [
      "SSO login failing with SAML assertion error",
      "Users locked out after enabling Okta SCIM provisioning",
      "2FA codes not arriving for some users",
      "Azure AD sign-in loops back to login page",
      "New hires can't accept workspace invite",
    ],
    bodies: [
      'Since this morning about a dozen of our users get "Invalid SAML assertion: audience mismatch" when signing in through Okta. Nothing changed on our side as far as we know. Can you check?',
      "We turned on SCIM provisioning yesterday and now several existing users are deactivated and can't log in. This is blocking our finance team.",
      "Some of our team members are not receiving their 2FA codes by SMS. It seems to affect people with +44 numbers.",
      'When our users click "Sign in with Microsoft" they are redirected back to the login page without an error. Cleared cookies, same result.',
    ],
    followUps: [
      "Attached is the SAML trace from one of the affected users. The audience value looks right to me.",
      "We tried again after re-syncing the group and it's still happening for 4 users.",
      "Here's the screenshot you asked for. It happens in Chrome and Safari.",
    ],
    asks: [
      "Could you send us a SAML trace (e.g. from the SAML-tracer extension) for one affected user, and confirm your IdP entity ID?",
      "Can you confirm which Okta group is assigned to the app and whether the affected users were pre-provisioned?",
      "Could you share the email addresses of two affected users so we can check their auth logs?",
    ],
    resolutions: [
      "We found that the audience URI changed during our certificate rotation. We've restored the previous value for your workspace and logins should work now. Please let us know if anyone is still affected.",
      "The deactivations came from a SCIM PATCH with active=false sent by the IdP. We've reactivated the users; please update the group assignment in Okta to prevent a repeat.",
    ],
    notes: [
      "Checked auth logs: audience mismatch started after cert rotation at 09:12 UTC. Pinging identity team.",
      "Looks like the SCIM connector sent active=false for these users. Not our bug, but let's help them fix the mapping.",
    ],
  },
  {
    key: "api_errors",
    weight: 20,
    priorities: [15, 40, 35, 5, 5],
    subjects: [
      "API returning 500 on POST /v2/events",
      "Webhook deliveries delayed by 30+ minutes",
      "Getting 429 rate limit errors well below our quota",
      "Pagination cursor returns duplicate records",
      "Timeouts on bulk import endpoint",
    ],
    bodies: [
      "Our ingestion job started failing at 02:00 UTC with HTTP 500 from POST /v2/events. Request IDs: req_8f2a, req_91bc. This is impacting production.",
      "Webhooks for order.updated are arriving 30-45 minutes late. Our fulfilment depends on these being near real-time.",
      "We're seeing 429s at about 40 requests/minute, but our plan allows 600/minute. Is something misconfigured on our account?",
      "When paging through /v2/contacts with the cursor, some records show up on two pages and others seem to be missing.",
    ],
    followUps: [
      "Still seeing errors intermittently. Another request ID: req_a77d.",
      "We added the retry logic you suggested but deliveries are still delayed.",
      "Here are the response headers from one of the 429s.",
    ],
    asks: [
      "Could you share a few more request IDs and the exact payload size you're sending?",
      "Can you confirm the webhook endpoint URL and whether it responds within 10 seconds?",
      "Could you send the full response headers from one of the 429 responses?",
    ],
    resolutions: [
      "Our engineering team deployed a fix for the serialization bug behind these 500s. Error rates are back to normal; please retry the failed batches.",
      "The delay was caused by a backed-up delivery queue in us-east. It's drained now and deliveries are real-time again.",
      "Your API key was attached to a legacy rate-limit tier. We've moved it to your plan's limit of 600/min.",
    ],
    notes: [
      "Reproduced the 500 with their payload. Filed ENG-4821, sev2.",
      "Queue lag dashboard confirms backlog in us-east webhook workers since 01:40.",
    ],
  },
  {
    key: "billing",
    weight: 14,
    priorities: [2, 10, 50, 30, 8],
    subjects: [
      "Invoice shows wrong seat count",
      "Charged twice for September",
      "Please update our billing contact",
      "Need a W-9 and updated PO number on invoice",
      "Question about annual plan proration",
    ],
    bodies: [
      "Our latest invoice bills us for 145 seats but we only have 118 active users. Can you correct this?",
      "We see two charges of the same amount on our card this month. Please refund the duplicate.",
      "Our finance contact has changed. Please send future invoices to accounts payable instead.",
      "We need the PO number on the invoice updated for our procurement system, otherwise it won't be paid.",
    ],
    followUps: ["The new PO number is on the attached form.", "Thanks — can you also confirm the refund timeline?"],
    asks: [
      "Could you confirm the new PO number and the billing email address we should use?",
      "Can you share the last four digits of the card and the charge dates?",
    ],
    resolutions: [
      "We've corrected the seat count and issued a credit note for the difference. You'll see it on your next invoice.",
      "The duplicate charge has been refunded; it should appear on your statement in 5-7 business days.",
    ],
    notes: ["Billing system shows 27 deactivated seats still counted. Flagging to finance ops."],
  },
  {
    key: "data_export",
    weight: 12,
    priorities: [3, 25, 50, 17, 5],
    subjects: [
      "CSV export times out for large workspace",
      "Scheduled export missing custom field columns",
      "Data export to S3 failing with AccessDenied",
      "GDPR data export request for a former employee",
    ],
    bodies: [
      "Exporting our full event history to CSV times out after about 10 minutes. We need this for a quarterly audit next week.",
      "Our nightly scheduled export stopped including the custom fields we added last month.",
      "The S3 export job fails with AccessDenied even though the bucket policy grants PutObject to your role ARN.",
    ],
    followUps: [
      "Attached is the bucket policy JSON.",
      "Tried a smaller date range and it worked, but the full range still fails.",
    ],
    asks: [
      "Could you share the bucket policy and the region of the bucket?",
      "Can you tell us the approximate row count and date range you're exporting?",
    ],
    resolutions: [
      "We've enabled asynchronous exports for your workspace; large exports now run in the background and you'll get an email when the file is ready.",
      "The export role needed s3:PutObjectAcl as well. After you added it, the latest run succeeded.",
    ],
    notes: ["Export worker hits the 10-min request timeout for >5M rows. Async export flag fixes it."],
  },
  {
    key: "outage",
    weight: 8,
    priorities: [55, 35, 10, 0, 0],
    subjects: [
      "Dashboard not loading for our entire team",
      "Elevated latency in EU region",
      "App is down — 502 Bad Gateway",
      'Reports stuck on "processing" for hours',
    ],
    bodies: [
      "Nobody on our team can load the dashboard, it just spins. This is a production outage for us.",
      "Everything is extremely slow for our EU users since about an hour ago. Pages take 20+ seconds.",
      "We're getting 502 Bad Gateway on every page. Is there an incident?",
    ],
    followUps: ["Still down for us. Any ETA?", "It's back for some users but not all."],
    asks: ["Could you confirm your workspace region and whether all users are affected?"],
    resolutions: [
      "The incident has been resolved; a faulty load balancer config in eu-west was rolled back. A post-incident report will follow on our status page.",
      "Service is fully restored. Root cause was a database failover that took longer than expected.",
    ],
    notes: ["Linked to INC-2291 on the status page.", "Incident commander confirms rollback complete."],
  },
  {
    key: "integrations",
    weight: 16,
    priorities: [5, 25, 55, 10, 5],
    subjects: [
      "Salesforce sync stopped updating opportunities",
      "Slack notifications no longer posting",
      "HubSpot integration duplicating contacts",
      "Zapier trigger not firing on new records",
    ],
    bodies: [
      'Our Salesforce sync hasn\'t updated any opportunities since Tuesday. The integration page says "connected".',
      "Slack alerts stopped posting to #ops-alerts after we renamed the channel.",
      "Every sync creates duplicate contacts in HubSpot for people who already exist.",
    ],
    followUps: ["We re-authorized the integration but it's still not syncing.", "Here's the sync log export."],
    asks: [
      "Could you re-authorize the integration and send us the time you did it?",
      "Can you export the sync log from Settings → Integrations and attach it here?",
    ],
    resolutions: [
      "The Salesforce refresh token had expired after a password reset. After re-authorizing, we replayed the missed syncs and your data is up to date.",
      "Renaming a Slack channel invalidates the webhook. We've reconnected it to #ops-alerts.",
    ],
    notes: ["Sync log shows invalid_grant from Salesforce since Tue 14:03."],
  },
  {
    key: "how_to",
    weight: 12,
    priorities: [0, 5, 45, 40, 10],
    subjects: [
      "How do I set up role-based permissions?",
      "Can we restrict exports to admins only?",
      "Best way to archive old projects?",
      "Is there an audit log for admin changes?",
    ],
    bodies: [
      "We'd like to give our contractors read-only access to two projects. What's the best way to set that up?",
      "Is it possible to restrict data exports to workspace admins?",
      "We have hundreds of stale projects. Is there a bulk archive option?",
    ],
    followUps: ["Thanks, that worked. One more question: does this apply to API keys too?"],
    asks: ["Which plan tier are you on, and do you use SSO groups for role assignment?"],
    resolutions: [
      "You can create a custom role under Settings → Roles with read-only access and assign it per project. Here's our guide: docs.example/roles.",
      "Yes — under Settings → Security you can limit exports to admins. This also applies to API keys created by non-admins.",
    ],
    notes: ["Feature request: bulk archive. Added to FR-311."],
  },
];

export const FIRST_REPLIES = [
  "Hi {first}, thanks for reaching out. I'm looking into this now and will update you shortly.",
  "Hi {first}, thanks for the report. I've reproduced the issue and I'm working with our engineers on it.",
  "Hello {first}, sorry for the trouble. I'm checking our logs for your workspace and will be back with details.",
];

export const PERIODIC_UPDATES = [
  "Quick update: our engineers are still working on this. I'll follow up as soon as I have more.",
  "Still on it — we've narrowed down the cause and a fix is in review.",
];

export const REOPEN_MESSAGES = [
  "Hi, this is happening again for us since yesterday.",
  "Unfortunately the problem is back. Can you take another look?",
];

export const THANKS = ["Thanks, confirmed it's working now!", "Great, that fixed it. Appreciate the quick help."];

export const BOT_ACK =
  "Thanks for contacting support! We've received your request and an agent will get back to you soon. Your ticket reference is {key}.";

export const PRIORITY_ORDER: (Priority | null)[] = ["urgent", "high", "normal", "low", null];
