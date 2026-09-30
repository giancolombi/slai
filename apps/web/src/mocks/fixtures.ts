/**
 * Realistic, deterministic demo data for "Acme Cloud", typed against @slai/shared.
 * Times are relative to the moment the fixtures are built, so clocks are live.
 */
import type {
  AgentAction,
  AgentRun,
  AuditEvent,
  AutonomyRule,
  Connection,
  ConnectorInfo,
  Contract,
  KnowledgeArticle,
  KnowledgeRef,
  KnowledgeSource,
  Me,
  Member,
  Metric,
  MetricState,
  NotificationChannel,
  OrgSettings,
  OrgSsoSettings,
  Policy,
  Priority,
  Replay,
  TicketStatus,
} from "@slai/shared";
import { type BillingInvoice, type BillingStatus, type PlanId, TRIAL } from "@slai/shared";
import {
  KESTREL_DOC,
  kestrelAmbiguities,
  kestrelCitations,
  kestrelDraftDefinition,
  premierDefinition,
  standardDefinition,
} from "./policies";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** mulberry32: a tiny seeded PRNG so every reload builds the same org. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo: number, hi: number) => lo + next() * (hi - lo),
    int: (lo: number, hi: number) => Math.floor(lo + next() * (hi - lo + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    weighted: <T>(list: readonly (readonly [T, number])[]): T => {
      const total = list.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of list) {
        r -= w;
        if (r <= 0) return v;
      }
      return list[list.length - 1]![0];
    },
  };
}

// ---------------------------------------------------------------- mock-internal shapes

export interface MockMetric {
  metric: Metric;
  state: MetricState;
  targetMs: number | null;
  /** Epoch ms the running cycle breaches (or breached). */
  dueAt: number | null;
  /** Remaining ms frozen while paused. */
  pausedRemainingMs: number | null;
  /** Elapsed ms frozen for achieved cycles. */
  frozenElapsedMs: number | null;
  breachCount: number;
}

export interface MockTicket {
  id: string;
  connectionId: string;
  provider: string;
  displayKey: string;
  url: string | null;
  subject: string;
  status: TicketStatus;
  priority: Priority | null;
  customerId: string | null;
  policyId: string | null;
  assigneeName: string | null;
  requester: { name: string | null; email: string | null };
  createdAt: number;
  updatedAt: number;
  metrics: MockMetric[];
  timeline: { at: string; type: string; label: string; author?: string; public?: boolean }[];
  agentRuns: AgentRun[];
}

export interface MockCustomer {
  id: string;
  name: string;
  domains: string[];
  externalOrgIds: string[];
  monthlyFeeCents: number | null;
  policyId: string | null;
  breachesThisPeriod: number;
}

// ---------------------------------------------------------------- org, people

export const ACME_ORG_ID = "5b2f0c1e-6f5d-4a8e-9d7c-1a2b3c4d5e01";
export const SANDBOX_ORG_ID = "5b2f0c1e-6f5d-4a8e-9d7c-1a2b3c4d5e02";

export function buildMe(): Me {
  return {
    user: { id: "u_maya", email: "maya@acmecloud.example", name: "Maya Okafor", mfaEnabled: true },
    organization: { id: ACME_ORG_ID, name: "Acme Cloud", slug: "acme-cloud", plan: "growth" },
    role: "owner",
    organizations: [
      { id: ACME_ORG_ID, name: "Acme Cloud", role: "owner" },
      { id: SANDBOX_ORG_ID, name: "Acme Cloud (Sandbox)", role: "admin" },
    ],
    security: { authMethod: "password", mfa: "satisfied", totp: true, passkeys: 1, hasPassword: true },
  };
}

/** Acme's SSO: one verified OIDC provider (Okta) and one SAML provider awaiting DNS verification. */
export function buildOrgSso(): OrgSsoSettings {
  const base = "http://localhost:8787/api/v1/auth/sso";
  return {
    enforceSso: false,
    requireMfaForSso: false,
    providers: [
      {
        id: "0d9c2d1e-2b0a-4c1e-9f00-5b0a00000001",
        providerId: "acme-okta-7f3a91c2",
        name: "Acme Okta",
        protocol: "oidc",
        issuer: "https://acmecloud.okta.example",
        domains: ["acmecloud.example"],
        domainVerified: true,
        domainVerification: null,
        clientId: "0oa8kq2slai",
        metadataUrl: null,
        callbackUrl: `${base}/callback/acme-okta-7f3a91c2`,
        createdAt: new Date(Date.now() - 40 * DAY).toISOString(),
      },
      {
        id: "0d9c2d1e-2b0a-4c1e-9f00-5b0a00000002",
        providerId: "acme-contractors-2c4d",
        name: "Contractors (Entra ID)",
        protocol: "saml",
        issuer: "https://sts.windows.example/acme-contractors",
        domains: ["contractors.acmecloud.example"],
        domainVerified: false,
        domainVerification: { recordName: "_slai-verification", recordValue: "slai-verification=Qm9vdHN0cmFwLXRva2Vu" },
        clientId: null,
        metadataUrl: "https://login.microsoftonline.example/acme/federationmetadata.xml",
        callbackUrl: `${base}/saml2/sp/acs/acme-contractors-2c4d`,
        createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
      },
    ],
  };
}

export function buildOrgSettings(): OrgSettings {
  return { id: ACME_ORG_ID, name: "Acme Cloud", plan: "growth", monthlySpendCapCents: 150_000 };
}

export const AGENTS = [
  "Priya Raman",
  "Tomás Ibarra",
  "Hannah Weiss",
  "Kofi Mensah",
  "Lena Novak",
  "Daniel Cho",
  "Sofia Marchetti",
  "Arjun Patel",
] as const;

export function buildMembers(now: number): Member[] {
  const roles: Member["role"][] = ["admin", "admin", "member", "member", "member", "member", "viewer", "member"];
  return [
    {
      userId: "u_maya",
      email: "maya@acmecloud.example",
      name: "Maya Okafor",
      role: "owner",
      mfaEnabled: true,
      lastLoginAt: new Date(now - 4 * MIN).toISOString(),
    },
    ...AGENTS.map((name, i) => ({
      userId: `u_${name
        .split(" ")[0]!
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z]/g, "")}`,
      email: `${name
        .split(" ")[0]!
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z]/g, "")}@acmecloud.example`,
      name,
      role: roles[i]!,
      mfaEnabled: i % 3 !== 2,
      lastLoginAt: i === 6 ? null : new Date(now - (i + 1) * 3.7 * HOUR).toISOString(),
    })),
  ];
}

// ---------------------------------------------------------------- connectors & connections

export const CONNECTORS: ConnectorInfo[] = [
  {
    provider: "zendesk",
    displayName: "Zendesk",
    authKind: "api_token",
    fields: [
      {
        key: "subdomain",
        label: "Subdomain",
        secret: false,
        placeholder: "acme",
        help: "The part before .zendesk.com",
      },
      { key: "email", label: "Admin email", secret: false, placeholder: "admin@acme.com" },
      {
        key: "apiToken",
        label: "API token",
        secret: true,
        help: "Admin Center → Apps and integrations → Zendesk API → Add API token",
      },
    ],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    docsUrl: "https://developer.zendesk.com/api-reference/",
    supportsKnowledge: true,
  },
  {
    provider: "jira_sm",
    displayName: "Jira Service Management",
    authKind: "basic",
    fields: [
      { key: "siteUrl", label: "Site URL", secret: false, placeholder: "https://acme.atlassian.net" },
      { key: "email", label: "Account email", secret: false, placeholder: "ops@acme.com" },
      { key: "apiToken", label: "API token", secret: true, help: "id.atlassian.com → Security → API tokens" },
      {
        key: "serviceDeskId",
        label: "Service desk ID",
        secret: false,
        placeholder: "2",
        help: "Optional; all desks if empty",
      },
    ],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: false },
    docsUrl: "https://developer.atlassian.com/cloud/jira/service-desk/rest/",
  },
  {
    provider: "intercom",
    displayName: "Intercom",
    authKind: "oauth2",
    fields: [{ key: "region", label: "Data region", secret: false, placeholder: "us", help: "us, eu or au" }],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    docsUrl: "https://developers.intercom.com/docs",
    supportsKnowledge: true,
  },
  {
    provider: "freshdesk",
    displayName: "Freshdesk",
    authKind: "api_token",
    fields: [
      { key: "domain", label: "Domain", secret: false, placeholder: "acme.freshdesk.com" },
      { key: "apiKey", label: "API key", secret: true, help: "Profile settings → Your API Key" },
    ],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    docsUrl: "https://developers.freshdesk.com/api/",
    supportsKnowledge: true,
  },
  {
    provider: "hubspot",
    displayName: "HubSpot Service Hub",
    authKind: "oauth2",
    fields: [],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: false, assign: true, priority: true, tags: false },
    docsUrl: "https://developers.hubspot.com/docs/api/crm/tickets",
  },
  {
    provider: "zammad",
    displayName: "Zammad",
    authKind: "api_token",
    fields: [
      { key: "baseUrl", label: "Instance URL", secret: false, placeholder: "https://support.acme.com" },
      { key: "token", label: "Access token", secret: true },
    ],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    docsUrl: "https://docs.zammad.org/en/latest/api/intro.html",
  },
  {
    provider: "help_scout",
    displayName: "Help Scout",
    authKind: "oauth2",
    fields: [
      { key: "appId", label: "App ID", secret: false },
      { key: "appSecret", label: "App secret", secret: true },
    ],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: false, tags: true },
    docsUrl: "https://developer.helpscout.com/mailbox-api/",
  },
  {
    provider: "demo",
    displayName: "Demo help desk",
    authKind: "api_token",
    fields: [
      {
        key: "scenario",
        label: "Scenario",
        secret: false,
        placeholder: "busy-week",
        help: "Simulated tickets for trying slai without a real help desk",
      },
    ],
    supportsWebhooks: false,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    docsUrl: "https://slai.example/docs/demo",
    supportsKnowledge: true,
  },
];

export const CONN_ZENDESK = "7c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e01";
export const CONN_JIRA = "7c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e02";
export const CONN_INTERCOM = "7c1d2e3f-0a1b-4c2d-8e3f-4a5b6c7d8e03";

export function buildConnections(now: number): Connection[] {
  return [
    {
      id: CONN_ZENDESK,
      provider: "zendesk",
      name: "Acme Zendesk",
      status: "active",
      lastSyncAt: new Date(now - 2 * MIN).toISOString(),
      lastError: null,
      mappingIssues: [],
      webhookUrl: `https://hooks.slai.example/v1/webhooks/${CONN_ZENDESK}`,
      ticketCount: 4_812,
      createdAt: new Date(now - 142 * DAY).toISOString(),
    },
    {
      id: CONN_JIRA,
      provider: "jira_sm",
      name: "Platform on-call (Jira SM)",
      status: "active",
      lastSyncAt: new Date(now - 6 * MIN).toISOString(),
      lastError: null,
      mappingIssues: [],
      webhookUrl: `https://hooks.slai.example/v1/webhooks/${CONN_JIRA}`,
      ticketCount: 402,
      createdAt: new Date(now - 61 * DAY).toISOString(),
    },
    {
      id: CONN_INTERCOM,
      provider: "intercom",
      name: "Intercom (self-serve)",
      status: "error",
      lastSyncAt: new Date(now - 3 * HOUR - 12 * MIN).toISOString(),
      lastError: "401 Unauthorized: the access token was revoked. Reconnect to resume syncing.",
      mappingIssues: [],
      webhookUrl: `https://hooks.slai.example/v1/webhooks/${CONN_INTERCOM}`,
      ticketCount: 1_137,
      createdAt: new Date(now - 30 * DAY).toISOString(),
    },
  ];
}

// ---------------------------------------------------------------- customers

export const POLICY_PREMIER = "3f6a1b2c-9d8e-4f7a-8b6c-5d4e3f2a1b01";
export const POLICY_STANDARD = "3f6a1b2c-9d8e-4f7a-8b6c-5d4e3f2a1b02";
export const POLICY_KESTREL = "3f6a1b2c-9d8e-4f7a-8b6c-5d4e3f2a1b03";
export const POLICY_PREMIER_V2 = "3f6a1b2c-9d8e-4f7a-8b6c-5d4e3f2a1b04";

const cust = (n: number) => `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c${String(n).padStart(2, "0")}`;
export const CUSTOMER_IDS = {
  northwind: cust(1),
  kestrel: cust(2),
  halcyon: cust(3),
  lumen: cust(4),
  parcelhub: cust(5),
  meridian: cust(6),
  fernwood: cust(7),
  quarry: cust(8),
  oakridge: cust(9),
  brightline: cust(10),
} as const;

export function buildCustomers(): MockCustomer[] {
  const c = (
    key: keyof typeof CUSTOMER_IDS,
    name: string,
    domain: string,
    fee: number | null,
    policyId: string | null,
    breaches: number,
  ): MockCustomer => ({
    id: CUSTOMER_IDS[key],
    name,
    domains: [domain],
    externalOrgIds: [`zd-${String(CUSTOMER_IDS[key]).slice(-4)}`],
    monthlyFeeCents: fee,
    policyId,
    breachesThisPeriod: breaches,
  });
  return [
    c("northwind", "Northwind Health", "northwindhealth.example", 4_200_000, POLICY_PREMIER, 3),
    c("kestrel", "Kestrel Bank", "kestrelbank.example", 6_800_000, null, 2),
    c("halcyon", "Halcyon Retail", "halcyonretail.example", 1_850_000, POLICY_PREMIER, 4),
    c("lumen", "Lumen Robotics", "lumenrobotics.example", 1_200_000, POLICY_STANDARD, 1),
    c("parcelhub", "Parcelhub", "parcelhub.example", 950_000, POLICY_STANDARD, 2),
    c("meridian", "Meridian Insurance", "meridian-ins.example", 3_100_000, POLICY_PREMIER, 1),
    c("fernwood", "Fernwood Schools", "fernwood.example", 380_000, POLICY_STANDARD, 0),
    c("quarry", "Quarry Analytics", "quarry.example", 720_000, POLICY_STANDARD, 1),
    c("oakridge", "Oakridge Clinics", "oakridgeclinics.example", 2_400_000, POLICY_PREMIER, 0),
    c("brightline", "Brightline Logistics", "brightline.example", null, null, 0),
  ];
}

// ---------------------------------------------------------------- policies & contracts

const CONTRACT = (n: number) => `c0a1b2c3-d4e5-4f6a-9b8c-7d6e5f4a3b${String(n).padStart(2, "0")}`;
export const CONTRACT_IDS = {
  northwind: CONTRACT(1),
  standard: CONTRACT(2),
  kestrel: CONTRACT(3),
  halcyon: CONTRACT(4),
  parcelhub: CONTRACT(5),
} as const;

export function buildPolicies(now: number): Policy[] {
  return [
    {
      id: POLICY_PREMIER,
      name: "Enterprise Premier",
      version: 3,
      status: "active",
      contractId: CONTRACT_IDS.northwind,
      isDefault: false,
      definition: { ...premierDefinition, id: POLICY_PREMIER },
      approvedBy: "Maya Okafor",
      approvedAt: new Date(now - 38 * DAY).toISOString(),
      createdAt: new Date(now - 39 * DAY).toISOString(),
    },
    {
      id: POLICY_STANDARD,
      name: "Standard Business",
      version: 2,
      status: "active",
      contractId: CONTRACT_IDS.standard,
      isDefault: true,
      definition: { ...standardDefinition, id: POLICY_STANDARD },
      approvedBy: "Priya Raman",
      approvedAt: new Date(now - 97 * DAY).toISOString(),
      createdAt: new Date(now - 98 * DAY).toISOString(),
    },
    {
      id: POLICY_KESTREL,
      name: "Kestrel Bank MSA",
      version: 1,
      status: "draft",
      contractId: CONTRACT_IDS.kestrel,
      isDefault: false,
      definition: { ...kestrelDraftDefinition, id: POLICY_KESTREL },
      approvedBy: null,
      approvedAt: null,
      createdAt: new Date(now - 22 * MIN).toISOString(),
    },
    {
      id: POLICY_PREMIER_V2,
      name: "Enterprise Premier",
      version: 2,
      status: "superseded",
      contractId: CONTRACT_IDS.northwind,
      isDefault: false,
      definition: { ...premierDefinition, id: POLICY_PREMIER_V2 },
      approvedBy: "Maya Okafor",
      approvedAt: new Date(now - 131 * DAY).toISOString(),
      createdAt: new Date(now - 132 * DAY).toISOString(),
    },
  ];
}

export function buildContracts(now: number): Contract[] {
  return [
    {
      id: CONTRACT_IDS.kestrel,
      filename: KESTREL_DOC,
      customerAccountId: CUSTOMER_IDS.kestrel,
      status: "needs_review",
      uploadedAt: new Date(now - 24 * MIN).toISOString(),
      uploadedBy: "Maya Okafor",
      error: null,
      extraction: {
        summary:
          "One SLA schedule (Schedule 4) covering four severities. UK business hours, 24x7 for Severity 1. Acknowledgement, update and resolution targets, a customer-wait pause on resolution, a £2,500 per-breach credit for Severity 1 and tiered attainment credits capped at 15% of monthly charges.",
        policyIds: [POLICY_KESTREL],
        ambiguities: kestrelAmbiguities,
        citations: kestrelCitations,
      },
    },
    {
      id: CONTRACT_IDS.halcyon,
      filename: "Halcyon Retail — Order Form Q3 2026.pdf",
      customerAccountId: CUSTOMER_IDS.halcyon,
      status: "extracting",
      uploadedAt: new Date(now - 90_000).toISOString(),
      uploadedBy: "Priya Raman",
      error: null,
      extraction: null,
    },
    {
      id: CONTRACT_IDS.northwind,
      filename: "Northwind Health — MSA and SLA Schedule.pdf",
      customerAccountId: CUSTOMER_IDS.northwind,
      status: "approved",
      uploadedAt: new Date(now - 39 * DAY).toISOString(),
      uploadedBy: "Maya Okafor",
      error: null,
      extraction: {
        summary:
          "Enterprise Premier support: 1h urgent first response 24x7, business-hours targets for other priorities, attainment credits.",
        policyIds: [POLICY_PREMIER],
        ambiguities: [],
        citations: [
          {
            path: "targets.first_response.urgent",
            quote: "Priority 1 requests will receive a first response within one (1) hour, 24 hours a day.",
            document: "Northwind Health — MSA and SLA Schedule.pdf",
            page: 8,
          },
        ],
      },
    },
    {
      id: CONTRACT_IDS.standard,
      filename: "Acme Cloud Standard Support Terms 2026.docx",
      customerAccountId: null,
      status: "approved",
      uploadedAt: new Date(now - 98 * DAY).toISOString(),
      uploadedBy: "Priya Raman",
      error: null,
      extraction: {
        summary: "Default support terms for all customers without a negotiated SLA.",
        policyIds: [POLICY_STANDARD],
        ambiguities: [],
        citations: [],
      },
    },
    {
      id: CONTRACT_IDS.parcelhub,
      filename: "parcelhub-renewal-scan.pdf",
      customerAccountId: CUSTOMER_IDS.parcelhub,
      status: "failed",
      uploadedAt: new Date(now - 3 * DAY).toISOString(),
      uploadedBy: "Kofi Mensah",
      error:
        "No SLA schedule found. The document looks like a scanned image without a text layer; upload a text PDF or DOCX.",
      extraction: null,
    },
  ];
}

// ---------------------------------------------------------------- tickets

const SUBJECTS: [string, string][] = [
  [
    "Production API returning 502s for EU tenants",
    "Since 09:40 UTC every call to /v2/orders from our EU tenants fails with a 502. This is blocking checkout.",
  ],
  [
    "SSO login loop after certificate rotation",
    "After we rotated our IdP signing cert this morning, users bounce between login and our IdP forever.",
  ],
  [
    "Webhook deliveries delayed by 30+ minutes",
    "Order webhooks are arriving 30–40 minutes late. Our warehouse is picking stale orders.",
  ],
  [
    "Billing export missing March invoices",
    "The CSV export from Billing → Invoices is missing every invoice from March.",
  ],
  [
    "Unable to add new seats to workspace",
    "Clicking 'Add seats' shows a spinner and then nothing happens. We need 25 seats for onboarding Monday.",
  ],
  [
    "Data residency question for new region",
    "Can you confirm that data for our Frankfurt workspace never leaves the EU, including backups?",
  ],
  ["Dashboard charts not loading in Safari", "The analytics dashboard stays blank in Safari 19. Chrome works."],
  ["Rate limit errors on bulk import", "Our nightly bulk import now hits 429s after about 2,000 records."],
  ["Password reset emails not arriving", "Several users report they never get password reset emails. Nothing in spam."],
  [
    "Request: raise file upload limit to 500 MB",
    "Our radiology team needs to upload studies larger than the current 100 MB limit.",
  ],
  [
    "Audit log export is empty for last week",
    "Security needs the audit log for last week and the export comes back with headers only.",
  ],
  ["Scheduled reports sent twice", "Every scheduled report went out twice this morning to all recipients."],
  [
    "Mobile app crashes on launch (Android 16)",
    "Since the latest update the Android app crashes immediately on launch for our field staff.",
  ],
  [
    "Cannot delete archived project",
    "Deleting an archived project returns 'Something went wrong'. We need it gone for compliance.",
  ],
  ["Latency spike on search endpoint", "p95 latency on /search went from 200ms to 3s around noon."],
  ["Question about SOC 2 report availability", "Could you share your latest SOC 2 Type II report under our NDA?"],
  [
    "Custom domain TLS certificate expired",
    "Our custom portal domain shows an expired certificate warning to customers.",
  ],
  ["Integration with Salesforce stopped syncing", "Opportunities stopped syncing to Salesforce yesterday at 17:00."],
  ["Invoice shows wrong VAT number", "Our last invoice lists an old VAT number. Finance needs a corrected copy."],
  ["User roles reset after SCIM sync", "After the nightly SCIM sync all our admins were downgraded to members."],
  [
    "Timeouts when generating PDF statements",
    "Generating monthly PDF statements times out for accounts with many transactions.",
  ],
  ["Two-factor codes rejected for some users", "Around a dozen users say valid TOTP codes are rejected."],
  [
    "How to configure IP allowlisting",
    "We'd like to restrict console access to our office IP ranges. Where is this configured?",
  ],
  ["Feature request: export to Parquet", "Our data team would like exports in Parquet for the warehouse."],
  ["Notifications sent to deactivated users", "Deactivated users still receive email notifications."],
  [
    "Checkout page shows stale prices",
    "Price changes made yesterday still aren't reflected on the hosted checkout page.",
  ],
  ["Workspace migration stuck at 80%", "The migration to the new workspace has been at 80% for six hours."],
  [
    "API key rotation broke integrations",
    "After rotating our API key per your advisory, two integrations fail with 401.",
  ],
  ["Search results missing new documents", "Documents uploaded today don't appear in search results."],
  [
    "Clarify renewal terms for support tier",
    "Before renewal, can you confirm what's included in the Premier support tier?",
  ],
];

const FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Sam",
  "Riley",
  "Morgan",
  "Casey",
  "Jamie",
  "Taylor",
  "Robin",
  "Avery",
  "Quinn",
  "Drew",
];
const LAST_NAMES = [
  "Hart",
  "Lindqvist",
  "Adeyemi",
  "Moreau",
  "Tanaka",
  "Okonkwo",
  "Silva",
  "Brennan",
  "Kowalski",
  "Haddad",
];

type Bucket = "ok" | "warning" | "at_risk" | "breached" | "paused" | "solved";

const BUCKETS: Bucket[] = [
  ...Array<Bucket>(7).fill("breached"),
  ...Array<Bucket>(9).fill("at_risk"),
  ...Array<Bucket>(12).fill("warning"),
  ...Array<Bucket>(26).fill("ok"),
  ...Array<Bucket>(6).fill("paused"),
  ...Array<Bucket>(4).fill("solved"),
];

function targetMinutes(policyId: string | null, metric: Metric, priority: Priority): number | null {
  const def =
    policyId === POLICY_PREMIER
      ? premierDefinition
      : policyId === POLICY_STANDARD
        ? standardDefinition
        : kestrelDraftDefinition;
  return def.targets.find((t) => t.metric === metric && t.priority === priority)?.minutes ?? null;
}

export function buildTickets(now: number, customers: MockCustomer[]): MockTicket[] {
  const r = rng(20260929);
  const tickets: MockTicket[] = [];
  // Interleave buckets deterministically so risks are spread across customers.
  const order = BUCKETS.map((b) => ({ b, k: r.next() })).sort((a, b) => a.k - b.k);

  order.forEach(({ b: bucket }, i) => {
    const customer = r.weighted(customers.map((c) => [c, c.monthlyFeeCents ? 3 : 1] as const));
    const policyId = customer.policyId ?? POLICY_STANDARD;
    const priority = r.weighted<Priority>([
      ["urgent", bucket === "breached" || bucket === "at_risk" ? 3 : 1],
      ["high", 4],
      ["normal", 6],
      ["low", 2],
    ]);
    const [subject, body] = SUBJECTS[i % SUBJECTS.length]!;
    const provider = i % 9 === 4 ? "jira_sm" : "zendesk";
    const connectionId = provider === "jira_sm" ? CONN_JIRA : CONN_ZENDESK;
    const key = provider === "jira_sm" ? `OPS-${1180 + i * 3}` : `#${48213 + i * 7}`;
    const first = r.pick(FIRST_NAMES);
    const last = r.pick(LAST_NAMES);
    const requester = {
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${customer.domains[0]}`,
    };
    const assigneeName = r.next() < 0.18 ? null : r.pick(AGENTS);

    const responded = bucket === "solved" || bucket === "paused" || r.next() < 0.55;
    const status: TicketStatus =
      bucket === "solved"
        ? "solved"
        : bucket === "paused"
          ? r.next() < 0.7
            ? "pending"
            : "on_hold"
          : responded
            ? "open"
            : "new";

    // The live metric: first response until answered, then resolution (or next response).
    const liveMetric: Metric = !responded ? "first_response" : r.next() < 0.35 ? "next_response" : "resolution";
    const liveTarget =
      (targetMinutes(policyId, liveMetric, priority) ?? targetMinutes(policyId, "resolution", priority) ?? 2400) * MIN;

    const fraction =
      bucket === "ok"
        ? r.between(0.06, 0.46)
        : bucket === "warning"
          ? r.between(0.52, 0.78)
          : bucket === "at_risk"
            ? r.between(0.82, 0.97)
            : bucket === "breached"
              ? r.between(1.03, 1.7)
              : r.between(0.2, 0.7);
    const elapsed = fraction * liveTarget;
    const createdAt = now - Math.max(elapsed * r.between(1.05, 1.6), 20 * MIN);

    const metrics: MockMetric[] = [];
    const frTarget = (targetMinutes(policyId, "first_response", priority) ?? 240) * MIN;
    if (liveMetric === "first_response") {
      metrics.push(liveMetricFrom("first_response", bucket, liveTarget, elapsed, now));
    } else {
      const frElapsed = frTarget * r.between(0.15, 0.85);
      metrics.push({
        metric: "first_response",
        state: "achieved",
        targetMs: frTarget,
        dueAt: null,
        pausedRemainingMs: null,
        frozenElapsedMs: frElapsed,
        breachCount: 0,
      });
    }
    const nrTarget = targetMinutes(policyId, "next_response", priority);
    if (liveMetric === "next_response") metrics.push(liveMetricFrom("next_response", bucket, liveTarget, elapsed, now));
    else
      metrics.push({
        metric: "next_response",
        state: nrTarget && responded ? "achieved" : "not_applicable",
        targetMs: nrTarget ? nrTarget * MIN : null,
        dueAt: null,
        pausedRemainingMs: null,
        frozenElapsedMs: nrTarget ? nrTarget * MIN * 0.3 : 0,
        breachCount: 0,
      });
    const puTarget = targetMinutes(policyId, "periodic_update", priority);
    metrics.push({
      metric: "periodic_update",
      state: "not_applicable",
      targetMs: puTarget ? puTarget * MIN : null,
      dueAt: null,
      pausedRemainingMs: null,
      frozenElapsedMs: 0,
      breachCount: 0,
    });
    const resTarget = (targetMinutes(policyId, "resolution", priority) ?? 7200) * MIN;
    if (liveMetric === "resolution") {
      metrics.push(liveMetricFrom("resolution", bucket, liveTarget, elapsed, now));
    } else {
      const resElapsed = Math.min(now - createdAt, resTarget * 0.6);
      metrics.push({
        metric: "resolution",
        state: bucket === "solved" ? "achieved" : "running",
        targetMs: resTarget,
        dueAt: bucket === "solved" ? null : now + (resTarget - resElapsed),
        pausedRemainingMs: null,
        frozenElapsedMs: bucket === "solved" ? resElapsed : null,
        breachCount: 0,
      });
    }
    if (bucket === "solved") for (const m of metrics) if (m.state === "running") m.state = "achieved";

    const id = `t_${String(i + 1).padStart(3, "0")}`;
    const timeline = buildTimeline(r, {
      createdAt,
      now,
      body,
      requester: requester.name,
      assignee: assigneeName,
      responded,
      bucket,
      status,
      priority,
      liveMetric,
      liveTarget,
      elapsed,
    });

    tickets.push({
      id,
      connectionId,
      provider,
      displayKey: key,
      url:
        provider === "jira_sm"
          ? `https://acme.atlassian.net/browse/${key}`
          : `https://acme.zendesk.com/agent/tickets/${key.slice(1)}`,
      subject,
      status,
      priority,
      customerId: customer.id,
      policyId,
      assigneeName,
      requester,
      createdAt,
      updatedAt: Math.max(...timeline.map((t) => new Date(t.at).getTime())),
      metrics,
      timeline,
      agentRuns: [],
    });
  });
  return tickets;
}

function liveMetricFrom(metric: Metric, bucket: Bucket, target: number, elapsed: number, now: number): MockMetric {
  if (bucket === "paused") {
    return {
      metric,
      state: "paused",
      targetMs: target,
      dueAt: null,
      pausedRemainingMs: target - elapsed,
      frozenElapsedMs: null,
      breachCount: 0,
    };
  }
  if (bucket === "solved") {
    return {
      metric,
      state: "achieved",
      targetMs: target,
      dueAt: null,
      pausedRemainingMs: null,
      frozenElapsedMs: elapsed,
      breachCount: 0,
    };
  }
  return {
    metric,
    state: "running",
    targetMs: target,
    dueAt: now + (target - elapsed),
    pausedRemainingMs: null,
    frozenElapsedMs: null,
    breachCount: 0,
  };
}

const METRIC_WORDS: Record<Metric, string> = {
  first_response: "First response",
  next_response: "Next response",
  periodic_update: "Periodic update",
  resolution: "Resolution",
};

function buildTimeline(
  r: ReturnType<typeof rng>,
  t: {
    createdAt: number;
    now: number;
    body: string;
    requester: string;
    assignee: string | null;
    responded: boolean;
    bucket: Bucket;
    status: TicketStatus;
    priority: Priority;
    liveMetric: Metric;
    liveTarget: number;
    elapsed: number;
  },
) {
  const span = t.now - t.createdAt;
  const at = (f: number) => new Date(t.createdAt + span * f).toISOString();
  const agent = t.assignee ?? "Priya Raman";
  const items: MockTicket["timeline"] = [
    { at: at(0), type: "created", label: `Ticket created with priority ${t.priority}` },
    { at: at(0.001), type: "requester_comment", label: t.body, author: t.requester, public: true },
  ];
  items.push({
    at: at(0.02),
    type: "agent_triage",
    label: `Triage: ${r.pick(["Bug", "Incident", "How-to", "Account", "Billing"])} · suggested priority ${t.priority} · confidence ${(0.8 + r.next() * 0.17).toFixed(2)}`,
    author: "slai agent",
  });
  if (t.assignee) items.push({ at: at(0.04), type: "assigned", label: `Assigned to ${t.assignee}` });
  if (t.responded) {
    items.push({
      at: at(0.18),
      type: "comment",
      label: `Hi ${t.requester.split(" ")[0]}, thanks for the report. I've reproduced this and escalated to our platform team. I'll update you within the hour.`,
      author: agent,
      public: true,
    });
    items.push({
      at: at(0.22),
      type: "comment",
      label: "Repro confirmed on staging. Looks related to Tuesday's deploy; pinged #platform-oncall.",
      author: agent,
      public: false,
    });
    items.push({ at: at(0.23), type: "status_changed", label: "Status changed from new to open" });
  }
  if (t.bucket === "paused") {
    items.push({
      at: at(0.5),
      type: "comment",
      label: "Could you send the request ID from one of the failing calls and the time it happened (with time zone)?",
      author: agent,
      public: true,
    });
    items.push({
      at: at(0.51),
      type: "paused",
      label: `Status changed to ${t.status}. ${METRIC_WORDS[t.liveMetric]} clock paused.`,
    });
  }
  const warnAt = (x: number) => (t.createdAt + (t.liveTarget * x) / 1) as number;
  if (["warning", "at_risk", "breached"].includes(t.bucket) && warnAt(0.5) < t.now) {
    items.push({
      at: new Date(Math.max(warnAt(0.5), t.createdAt + 1000)).toISOString(),
      type: "sla_warning",
      label: `${METRIC_WORDS[t.liveMetric]} passed 50% of target`,
    });
  }
  if (["at_risk", "breached"].includes(t.bucket) && warnAt(0.8) < t.now) {
    items.push({
      at: new Date(warnAt(0.8)).toISOString(),
      type: "sla_at_risk",
      label: `${METRIC_WORDS[t.liveMetric]} at risk (80% of target). Draft reply requested from agent.`,
    });
  }
  if (t.bucket === "breached" && warnAt(1) < t.now) {
    items.push({
      at: new Date(warnAt(1)).toISOString(),
      type: "sla_breached",
      label: `${METRIC_WORDS[t.liveMetric]} target breached`,
    });
  }
  if (t.bucket === "solved") {
    items.push({
      at: at(0.9),
      type: "comment",
      label: "The fix is deployed. Please let us know if you see this again.",
      author: agent,
      public: true,
    });
    items.push({ at: at(0.92), type: "status_changed", label: "Status changed from open to solved" });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------- agent actions & runs

const DRAFTS = [
  "Hi {first},\n\nQuick update: we've identified the cause. A configuration change in our EU edge rolled out at 09:38 UTC and is returning 502s for a subset of routes. We're rolling it back now and expect recovery within 20 minutes.\n\nI'll confirm here as soon as traffic is healthy.\n\n{agent}",
  "Hi {first},\n\nThanks for your patience. Our engineers confirmed the issue and a fix is being tested. In the meantime you can work around it by retrying the request with the X-Region: us header.\n\nI'll update you again by {time} at the latest.\n\n{agent}",
  "Hi {first},\n\nI've escalated this to our platform team as a priority incident. They're investigating the delayed deliveries now. Nothing is lost: queued events will be delivered in order once the backlog clears.\n\nNext update within the hour.\n\n{agent}",
  "Hi {first},\n\nI can confirm the missing records were caused by a timezone boundary bug in the export. We've patched it; please re-run the export and let me know if anything is still missing.\n\n{agent}",
  "Hi {first},\n\nWe've reproduced the login loop. It's caused by the new certificate not yet being trusted on our side. I've uploaded it to your SSO configuration; please try signing in again in a private window.\n\n{agent}",
  "Hi {first},\n\nThanks for flagging this. Our team is investigating the spike and has already added capacity to the search cluster. Latency should be back to normal shortly; I'll follow up with a root cause.\n\n{agent}",
  "Hi {first},\n\nSorry for the trouble. As a goodwill gesture we'll credit 20% of this month's invoice ($1,240) to your account.\n\n{agent}",
];

/** A draft that fits the ticket: a specific one for known incidents, otherwise one that names the request. */
function draftFor(subject: string): string {
  const specific: [RegExp, number][] = [
    [/502s/, 0],
    [/SSO/, 4],
    [/[Ww]ebhook/, 2],
    [/export missing|export is empty/, 3],
    [/[Ll]atency|[Tt]imeouts/, 5],
  ];
  const hit = specific.find(([re]) => re.test(subject));
  if (hit) return DRAFTS[hit[1]]!;
  if (/^(Feature request|Request|Question|How to|Clarify)/.test(subject)) {
    return `Hi {first},\n\nThanks for asking about this ("${subject}"). I've shared it with the product team with your use case, and I'll come back to you by {time} with a clear answer on what's possible today and what's planned.\n\n{agent}`;
  }
  return `Hi {first},\n\nThanks for reporting "${subject}". We've reproduced it and an engineer is working on a fix now. I'll update you by {time} at the latest, sooner if we have a workaround.\n\n{agent}`;
}

export function buildActions(now: number, tickets: MockTicket[], riskOf: (t: MockTicket) => string): AgentAction[] {
  const r = rng(7);
  const hot = tickets.filter((t) => ["at_risk", "breached"].includes(riskOf(t)) && t.status !== "solved").slice(0, 8);
  const actions: AgentAction[] = hot.map((t, i) => {
    const first = t.requester.name?.split(" ")[0] ?? "there";
    const template = i === 6 ? DRAFTS[6]! : draftFor(t.subject);
    const blocked = i === 6;
    return {
      id: `act_${String(i + 1).padStart(3, "0")}`,
      ticketId: t.id,
      ticketKey: t.displayKey,
      ticketSubject: t.subject,
      kind: i === 5 ? "internal_note" : "public_reply",
      status: blocked ? "blocked" : "proposed",
      body: template
        .replace("{first}", first)
        .replace("{agent}", t.assigneeName ?? "The Acme Cloud support team")
        .replace(
          "{time}",
          new Date(now + 2 * HOUR).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        ),
      payload: { tone: "reassuring" },
      usedKnowledge: blocked || i === 5 ? [] : knowledgeRefsFor(t.subject),
      confidence: blocked ? 0.91 : Number((0.71 + r.next() * 0.25).toFixed(2)),
      blockedReason: blocked ? "Guardrail: mentions a credit amount (pricing/legal commitment). Needs a human." : null,
      createdAt: new Date(now - (i * 7 + 3) * MIN).toISOString(),
      decidedBy: null,
      decidedAt: null,
    };
  });
  // History
  const past = tickets.slice(20, 30);
  past.forEach((t, i) => {
    const sent = i % 3 !== 2;
    actions.push({
      id: `act_h${i}`,
      ticketId: t.id,
      ticketKey: t.displayKey,
      ticketSubject: t.subject,
      kind: "public_reply",
      status: sent ? "sent" : "rejected",
      body: DRAFTS[i % 6]!.replace("{first}", t.requester.name?.split(" ")[0] ?? "there")
        .replace("{agent}", t.assigneeName ?? "Acme Cloud support")
        .replace("{time}", "3:00 PM"),
      payload: {},
      usedKnowledge: knowledgeRefsFor(t.subject),
      confidence: Number((0.78 + r.next() * 0.2).toFixed(2)),
      blockedReason: null,
      createdAt: new Date(now - (i + 2) * 5 * HOUR).toISOString(),
      decidedBy: sent ? (i % 2 ? "autopilot" : r.pick(AGENTS)) : r.pick(AGENTS),
      decidedAt: new Date(now - (i + 2) * 5 * HOUR + 4 * MIN).toISOString(),
    });
  });
  return actions;
}

export function buildRuns(now: number, ticket: MockTicket, hasDraft: boolean): AgentRun[] {
  const runs: AgentRun[] = [
    {
      id: `run_${ticket.id}_triage`,
      kind: "triage",
      status: "succeeded",
      model: "claude-haiku",
      costCents: 1,
      sandboxSeconds: 4.2,
      startedAt: new Date(ticket.createdAt + 40_000).toISOString(),
      finishedAt: new Date(ticket.createdAt + 46_000).toISOString(),
      error: null,
      output: { category: "incident", suggestedPriority: ticket.priority, summary: ticket.subject, confidence: 0.9 },
    },
  ];
  if (hasDraft) {
    runs.push({
      id: `run_${ticket.id}_draft`,
      kind: "draft_reply",
      status: "succeeded",
      model: "claude-sonnet",
      costCents: 6,
      sandboxSeconds: 11.8,
      startedAt: new Date(now - 14 * MIN).toISOString(),
      finishedAt: new Date(now - 13.5 * MIN).toISOString(),
      error: null,
      output: { confidence: 0.86 },
    });
  }
  return runs;
}

// ---------------------------------------------------------------- autonomy, channels

export function buildAutonomyRules(): AutonomyRule[] {
  return [
    {
      id: "ar_default",
      customerAccountId: null,
      priority: null,
      level: "assist",
      triggerAt: "at_risk",
      minConfidence: 0.8,
    },
    {
      id: "ar_urgent",
      customerAccountId: null,
      priority: "urgent",
      level: "assist",
      triggerAt: "warning",
      minConfidence: 0.8,
    },
    {
      id: "ar_low",
      customerAccountId: null,
      priority: "low",
      level: "observe",
      triggerAt: "at_risk",
      minConfidence: 0.8,
    },
    {
      id: "ar_northwind",
      customerAccountId: CUSTOMER_IDS.northwind,
      priority: null,
      level: "autopilot",
      triggerAt: "at_risk",
      minConfidence: 0.88,
    },
    {
      id: "ar_northwind_urgent",
      customerAccountId: CUSTOMER_IDS.northwind,
      priority: "urgent",
      level: "assist",
      triggerAt: "warning",
      minConfidence: 0.9,
    },
    {
      id: "ar_kestrel",
      customerAccountId: CUSTOMER_IDS.kestrel,
      priority: null,
      level: "observe",
      triggerAt: "warning",
      minConfidence: 0.9,
    },
    {
      id: "ar_fernwood",
      customerAccountId: CUSTOMER_IDS.fernwood,
      priority: null,
      level: "autopilot",
      triggerAt: "warning",
      minConfidence: 0.8,
    },
  ];
}

export function buildChannels(): NotificationChannel[] {
  return [
    { id: "nc_1", kind: "email", target: "support-leads@acmecloud.example", minRisk: "at_risk", enabled: true },
    {
      id: "nc_2",
      kind: "slack_webhook",
      target: "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
      minRisk: "breached",
      enabled: true,
    },
    { id: "nc_3", kind: "email", target: "maya@acmecloud.example", minRisk: "breached", enabled: false },
  ];
}

// ---------------------------------------------------------------- replays

export function replayResult(tickets = 4_812): NonNullable<Replay["result"]> {
  return {
    tickets,
    breaches: 137,
    attainmentPercent: 97.2,
    exposureCents: 4_862_500,
    medianLeadMinutes: 196,
    byCustomer: [
      { customerId: CUSTOMER_IDS.halcyon, name: "Halcyon Retail", breaches: 38, exposureCents: 1_387_500 },
      { customerId: CUSTOMER_IDS.northwind, name: "Northwind Health", breaches: 29, exposureCents: 1_260_000 },
      { customerId: CUSTOMER_IDS.kestrel, name: "Kestrel Bank", breaches: 11, exposureCents: 1_020_000 },
      { customerId: CUSTOMER_IDS.meridian, name: "Meridian Insurance", breaches: 17, exposureCents: 620_000 },
      { customerId: CUSTOMER_IDS.parcelhub, name: "Parcelhub", breaches: 21, exposureCents: 285_000 },
      { customerId: CUSTOMER_IDS.lumen, name: "Lumen Robotics", breaches: 12, exposureCents: 180_000 },
      { customerId: CUSTOMER_IDS.quarry, name: "Quarry Analytics", breaches: 6, exposureCents: 110_000 },
      { customerId: null, name: "No customer matched", breaches: 3, exposureCents: 0 },
    ],
    byMetric: [
      { metric: "first_response", breaches: 58, measured: 4_812 },
      { metric: "next_response", breaches: 31, measured: 2_904 },
      { metric: "periodic_update", breaches: 9, measured: 212 },
      { metric: "resolution", breaches: 39, measured: 4_530 },
    ],
  };
}

export function buildReplays(now: number): Replay[] {
  return [
    {
      id: "rp_0192",
      connectionId: CONN_ZENDESK,
      days: 90,
      status: "succeeded",
      progress: { ticketsScanned: 4_812, ticketsTotal: 4_812 },
      result: replayResult(),
      createdAt: new Date(now - 2 * DAY - 3 * HOUR).toISOString(),
    },
    {
      id: "rp_0171",
      connectionId: CONN_JIRA,
      days: 30,
      status: "succeeded",
      progress: { ticketsScanned: 402, ticketsTotal: 402 },
      result: {
        tickets: 402,
        breaches: 9,
        attainmentPercent: 98.9,
        exposureCents: 212_000,
        medianLeadMinutes: 64,
        byCustomer: [
          { customerId: CUSTOMER_IDS.northwind, name: "Northwind Health", breaches: 5, exposureCents: 168_000 },
          { customerId: CUSTOMER_IDS.oakridge, name: "Oakridge Clinics", breaches: 4, exposureCents: 44_000 },
        ],
        byMetric: [
          { metric: "first_response", breaches: 6, measured: 402 },
          { metric: "resolution", breaches: 3, measured: 380 },
        ],
      },
      createdAt: new Date(now - 19 * DAY).toISOString(),
    },
  ];
}

// ---------------------------------------------------------------- audit

export function buildAudit(now: number): AuditEvent[] {
  const r = rng(99);
  const templates: [AuditEvent["actor"]["type"], string, string, (i: number) => unknown][] = [
    ["user", "auth.login", "user", () => ({ method: "password+totp" })],
    ["user", "action.approved", "agent_action", (i) => ({ ticket: `#${48213 + i * 7}`, edited: i % 2 === 0 })],
    ["agent", "action.sent", "agent_action", (i) => ({ ticket: `#${48213 + i * 7}`, via: "zendesk", autopilot: true })],
    ["user", "action.rejected", "agent_action", () => ({ reason: "Tone too casual for this customer" })],
    ["system", "connection.sync_failed", "connection", () => ({ provider: "intercom", status: 401 })],
    ["user", "policy.approved", "policy", () => ({ name: "Enterprise Premier", version: 3 })],
    ["user", "autonomy.updated", "autonomy_rule", () => ({ scope: "Northwind Health", level: "autopilot" })],
    ["user", "member.invited", "member", () => ({ email: "new.agent@acmecloud.example", role: "member" })],
    ["user", "contract.uploaded", "contract", () => ({ filename: KESTREL_DOC })],
    ["system", "replay.completed", "replay", () => ({ days: 90, breaches: 137 })],
    ["user", "connection.created", "connection", () => ({ provider: "jira_sm" })],
    ["user", "org.updated", "organization", () => ({ monthlySpendCapCents: 150_000 })],
    ["user", "auth.mfa_enabled", "user", () => ({})],
  ];
  const people = ["Maya Okafor", ...AGENTS];
  const events: AuditEvent[] = [];
  let t = now - 3 * MIN;
  for (let i = 0; i < 120; i++) {
    const [type, action, target, meta] = templates[i % templates.length]!;
    const name = type === "user" ? r.pick(people) : type === "agent" ? "slai agent (autopilot)" : null;
    events.push({
      id: `ae_${String(i).padStart(4, "0")}`,
      at: new Date(t).toISOString(),
      actor: { type, id: type === "system" ? null : `id_${i}`, name },
      action,
      target: { type: target, id: `${target}_${(i * 37) % 997}` },
      metadata: meta(i),
      ip: type === "user" ? `203.0.113.${(i * 13) % 250}` : null,
    });
    t -= r.between(4, 95) * MIN;
  }
  return events;
}

// ---------------------------------------------------------------- billing (T-65)

/** The stored billing facts for a mock org; `billing()` in db.ts derives the BillingSummary. */
export interface MockBilling {
  mode: "stripe" | "manual";
  plan: PlanId;
  status: BillingStatus;
  trialEndsAt: string | null;
  pastDueSince: string | null;
  /** Credit packs bought and not yet used. */
  purchasedCredits: number;
  hasCustomer: boolean;
  hasSubscription: boolean;
  invoices: BillingInvoice[];
}

/** A new org: the 14-day Growth trial, `daysLeft` from now (Acme starts with 9). */
export function buildTrialBilling(now: number, daysLeft: number = TRIAL.days): MockBilling {
  return {
    mode: "stripe",
    plan: TRIAL.plan,
    status: "trialing",
    // A little under the whole days, so "days left" reads exactly `daysLeft`.
    trialEndsAt: new Date(now + daysLeft * DAY - HOUR).toISOString(),
    pastDueSince: null,
    purchasedCredits: 0,
    hasCustomer: false,
    hasSubscription: false,
    invoices: [],
  };
}

/** Paid invoices for a subscription started this month (and one the month before). */
export function buildInvoices(now: number, priceCents: number): BillingInvoice[] {
  return [0, 1].map((monthsAgo) => {
    const at = new Date(now);
    at.setUTCDate(1);
    at.setUTCHours(0, 5, 0, 0);
    at.setUTCMonth(at.getUTCMonth() - monthsAgo);
    const n = 1042 - monthsAgo;
    return {
      id: `in_mock_${n}`,
      number: `ACME-${n}`,
      status: "paid",
      amountDueCents: priceCents,
      amountPaidCents: priceCents,
      createdAt: at.toISOString(),
      hostedUrl: null,
      pdfUrl: null,
    };
  });
}

// ---------------------------------------------------------------- knowledge (T-47)

export const KS_HELP_CENTER = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c01";
export const KS_SAVED_REPLIES = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c02";
const kb = (n: number) => `8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b${String(n).padStart(2, "0")}`;
const HELP = "https://help.acme-cloud.example";

/** A knowledge source as the mock stores it; counts are derived from the articles at read time. */
export type MockKnowledgeSource = Omit<KnowledgeSource, "articleCount" | "enabledCount">;

const HELP_ARTICLES: [string, string, string][] = [
  [
    "Fix “Invalid SAML assertion: audience mismatch”",
    "sso/saml-audience-mismatch",
    "This error means the Audience URI (SP Entity ID) your identity provider sends doesn't match your workspace. In Okta or Azure AD, set the Audience URI to https://app.acme-cloud.example/saml/<workspace-id>, then ask affected users to sign in again from a private window.",
  ],
  [
    "Rotate your SSO signing certificate without downtime",
    "sso/rotate-certificate",
    "Upload the new certificate under Settings → Security → SSO before you activate it in your IdP. Acme Cloud accepts both certificates for 72 hours, so users are never locked out during the switch.",
  ],
  [
    "Troubleshoot SCIM provisioning with Okta",
    "sso/scim-okta",
    "Users are deactivated when the IdP sends a SCIM PATCH with active=false, usually after a group is unassigned. Reassign the group in Okta and the users are reactivated on the next push.",
  ],
  [
    "Two-factor codes not arriving by SMS",
    "account/2fa-sms",
    "Some carriers delay short-code SMS. Ask affected users to switch to an authenticator app under Profile → Security, or use a backup code to sign in.",
  ],
  [
    "API error codes and what to do about them",
    "api/errors",
    "5xx responses are safe to retry with exponential backoff; include the request ID (req_…) when you contact support. 4xx responses mean the request itself needs to change.",
  ],
  [
    "Rate limits: how they work and how to raise them",
    "api/rate-limits",
    "Each API key has a per-minute limit that matches your plan (600 requests/minute on Growth). A 429 response carries a Retry-After header; wait that many seconds before retrying.",
  ],
  [
    "Webhook delivery, retries and ordering",
    "webhooks/delivery",
    "Webhooks are delivered at least once, in order per resource. Your endpoint must answer within 10 seconds; slower responses are retried with backoff and can make deliveries look delayed.",
  ],
  [
    "Bulk import limits and batching",
    "api/bulk-import",
    "The bulk import endpoint accepts up to 1,000 records per request. For larger imports, send batches sequentially and respect the Retry-After header on 429 responses.",
  ],
  [
    "Export large workspaces with asynchronous exports",
    "exports/async-exports",
    "Exports over 5 million rows run in the background. Start the export from Settings → Data → Export and you'll get an email with a download link when the file is ready.",
  ],
  [
    "Export to Amazon S3: required permissions",
    "exports/s3-permissions",
    "The export role needs s3:PutObject and s3:PutObjectAcl on the target bucket. AccessDenied errors almost always mean one of these is missing from the bucket policy.",
  ],
  [
    "Understand your invoice and seat count",
    "billing/invoices",
    "Invoices count every active seat on the billing date. Deactivated users stop counting on the next invoice. You can download past invoices under Settings → Billing.",
  ],
  [
    "Supported browsers",
    "general/supported-browsers",
    "Acme Cloud supports the latest two versions of Chrome, Edge, Firefox and Safari. If charts stay blank in Safari, turn off “Prevent cross-site tracking” for app.acme-cloud.example or update Safari.",
  ],
];

const SAVED_REPLIES: [string, string, string | null][] = [
  [
    "Ask for a SAML trace",
    "To see exactly what your identity provider sends, please capture a SAML trace with the SAML-tracer browser extension while an affected user signs in, and attach it here. Please also confirm your IdP entity ID.",
    `${HELP}/sso/saml-tracer`,
  ],
  [
    "Where to find past invoices",
    "You can download every past invoice as a PDF under Settings → Billing → Invoices. Only workspace owners and billing admins can see this page.",
    null,
  ],
];

export function buildKnowledge(now: number): { sources: MockKnowledgeSource[]; articles: KnowledgeArticle[] } {
  const sources: MockKnowledgeSource[] = [
    {
      id: KS_HELP_CENTER,
      connectionId: CONN_ZENDESK,
      kind: "helpdesk_articles",
      name: "Acme Help Center",
      status: "idle",
      lastSyncAt: new Date(now - 5 * HOUR).toISOString(),
      lastError: null,
      createdAt: new Date(now - 90 * DAY).toISOString(),
    },
    {
      id: KS_SAVED_REPLIES,
      connectionId: null,
      kind: "manual",
      name: "Saved replies",
      status: "idle",
      lastSyncAt: null,
      lastError: null,
      createdAt: new Date(now - 40 * DAY).toISOString(),
    },
  ];
  const articles: KnowledgeArticle[] = HELP_ARTICLES.map(([title, path, bodyText], i) => ({
    id: kb(i + 1),
    sourceId: KS_HELP_CENTER,
    sourceKind: "helpdesk_articles",
    sourceName: "Acme Help Center",
    externalId: String(360_041_000 + i * 17),
    title,
    url: `${HELP}/${path}`,
    bodyText,
    locale: "en-us",
    // The browser-support article is switched off to show the toggle.
    enabled: path !== "general/supported-browsers",
    updatedAt: new Date(now - (i * 3 + 2) * DAY).toISOString(),
  }));
  SAVED_REPLIES.forEach(([title, bodyText, url], i) => {
    articles.push({
      id: kb(50 + i),
      sourceId: KS_SAVED_REPLIES,
      sourceKind: "manual",
      sourceName: "Saved replies",
      externalId: null,
      title,
      url,
      bodyText,
      locale: null,
      enabled: true,
      updatedAt: new Date(now - (i * 9 + 4) * DAY).toISOString(),
    });
  });
  return { sources, articles };
}

/** The help-center articles a draft about `subject` would plausibly cite (fixture stand-in for retrieval). */
export function knowledgeRefsFor(subject: string): KnowledgeRef[] {
  const rules: [RegExp, number[]][] = [
    [/SSO|SAML|login|certificate/i, [1, 2]],
    [/SCIM|provision/i, [3]],
    [/2FA|two-factor/i, [4]],
    [/[Rr]ate limit|429|bulk import/i, [6, 8]],
    [/[Ww]ebhook/i, [7]],
    [/502|500|API/i, [5]],
    [/[Ee]xport/i, [9, 10]],
    [/[Ii]nvoice|seat/i, [11]],
  ];
  const hit = rules.find(([re]) => re.test(subject));
  if (!hit) return [];
  return hit[1].map((n) => {
    const [title, path] = HELP_ARTICLES[n - 1]!;
    return { id: kb(n), title, url: `${HELP}/${path}` };
  });
}
