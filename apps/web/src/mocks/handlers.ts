import type {
  AgentAction,
  AutonomyRule,
  Connection,
  ConnectionMapping,
  Contract,
  ContractText,
  CustomerAccount,
  FieldMappingTable,
  Invitation,
  InvitationPreview,
  KnowledgeArticle,
  KnowledgeSource,
  List,
  Member,
  NotificationChannel,
  Offboarding,
  OnboardingState,
  OnboardingStepId,
  OrgExport,
  Policy,
  Replay,
  ScimSettings,
  ScimTokenCreated,
  SecondFactor,
  SignInDiscovery,
  SignInResult,
  SsoProvider,
  TotpEnrollment,
} from "@slai/shared";
import {
  API_BASE,
  approveActionBody,
  autonomyRuleBody,
  billingCheckoutBody,
  CREDIT_PACKS,
  createConnectionBody,
  createKnowledgeSourceBody,
  createPolicyBody,
  createReplayBody,
  createScimTokenBody,
  createSsoProviderBody,
  creditPackCheckoutBody,
  discoverBody,
  inviteBody,
  knowledgeArticleQuery,
  loginBody,
  manualBillingBody,
  notificationChannelBody,
  ONBOARDING_STEPS,
  OPTIONAL_ONBOARDING_STEPS,
  ORG_DELETION_GRACE_DAYS,
  PLANS,
  type PlanId,
  policyPreviewBody,
  rejectActionBody,
  resetMemberMfaBody,
  savedReplyBody,
  scheduleDeletionBody,
  scimGroupRoleBody,
  signupBody,
  switchOrgBody,
  TRIAL,
  updateKnowledgeArticleBody,
  updateMappingBody,
  updateMemberBody,
  updateOnboardingBody,
  updateOrgBody,
  updateOrgSsoBody,
  updatePolicyBody,
  updateSavedReplyBody,
  upsertCustomerBody,
  verifyBackupCodeBody,
  verifyTotpBody,
} from "@slai/shared";
import { delay, HttpResponse, http } from "msw";
import type { z } from "zod";
import { matchesArticle } from "../lib/knowledge";
import {
  audit,
  billing,
  dashboard,
  emptyOrg,
  getDb,
  MOCK_BACKUP_CODES,
  org,
  resetDb,
  saveDb,
  toDetail,
  toSummary,
  usage,
} from "./db";
import {
  buildCustomers,
  buildInvoices,
  buildTickets,
  CONNECTORS,
  knowledgeRefsFor,
  type MockKnowledgeSource,
  replayResult,
} from "./fixtures";
import { kestrelAmbiguities, kestrelCitations, kestrelDraftDefinition } from "./policies";

const url = (path: string) => `${API_BASE}${path}`;

const offboarding = new Map<string, Offboarding>();
function offboardingFor(orgId: string): Offboarding {
  let s = offboarding.get(orgId);
  if (!s) {
    s = { deletion: null, exports: [], graceDays: ORG_DELETION_GRACE_DAYS };
    offboarding.set(orgId, s);
  }
  return s;
}

/** Mapping mock (T-25): one shared default, per-connection overrides in memory. */
const MOCK_DEFAULT_MAPPING: FieldMappingTable = {
  status: { new: "new", open: "open", pending: "pending", hold: "on_hold", solved: "solved", closed: "closed" },
  priority: { urgent: "urgent", high: "high", normal: "normal", low: "low" },
};
const MOCK_OVERRIDES = new Map<string, FieldMappingTable>();
function mockMapping(c: Connection): ConnectionMapping {
  return {
    defaults: MOCK_DEFAULT_MAPPING,
    overrides: MOCK_OVERRIDES.get(c.id) ?? { status: {}, priority: {} },
    unmapped: c.mappingIssues,
    observed: { status: ["open", "pending", "solved", "Waiting on engineering"], priority: ["high", "normal"] },
  };
}

function fail(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json({ error: { code, message, details } }, { status });
}

async function latency(min = 120, max = 420) {
  await delay(Math.round(min + Math.random() * (max - min)));
}

function list<T>(items: T[], nextCursor: string | null = null): List<T> {
  return { items, nextCursor };
}

/** Validates a JSON body with the shared zod schema, like the API does. */
async function parse<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S> | Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    json = {};
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return fail(400, "validation_failed", "Some fields are not valid.", result.error.issues);
  }
  return result.data;
}

function requireCsrf(request: Request) {
  return request.headers.get("X-Requested-With") === "slai"
    ? null
    : fail(403, "csrf", "Missing X-Requested-With header.");
}

/** The session check plus the API's MFA gate: no second factor, no data. */
function requireSession() {
  const d = getDb();
  if (d.session !== "in") return fail(401, "unauthorized", "Please sign in.");
  if (d.me.security.mfa === "enrollment_required") {
    return fail(403, "mfa_enrollment_required", "Set up two-factor authentication to continue.");
  }
  if (d.me.security.mfa === "verification_required") return fail(403, "mfa_required", "Verify your second factor.");
  return null;
}

/** The verified SSO provider (in any mock org) for an email's domain. */
function ssoProviderFor(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  for (const o of Object.values(getDb().orgs)) {
    const provider = o.sso.providers.find((p) => p.domainVerified && domain && p.domains.includes(domain));
    if (provider) return { provider, enforced: o.sso.enforceSso };
  }
  return null;
}

const isAdmin = () => ["owner", "admin"].includes(getDb().me.role);
const stepUpWindow = () => new Date(Date.now() + 5 * 60_000).toISOString();
const stepUpFresh = () => {
  const until = getDb().me.security.stepUpUntil;
  return until !== null && new Date(until).getTime() > Date.now();
};
/** SCIM settings are created lazily (older persisted mock databases have none). */
function scim(): ScimSettings {
  const o = org();
  o.scim ??= { baseUrl: "http://localhost:8787/scim/v2", tokens: [], groupRoles: [] };
  return o.scim;
}
const actor = () => getDb().me.user.name;
const actorId = () => getDb().me.user.id;

/** Wraps a handler with session + CSRF checks, the persisted save, and latency. */
function guarded<Args extends { request: Request; params: Record<string, string | readonly string[] | undefined> }>(
  fn: (args: Args) => Response | Promise<Response>,
  opts: { admin?: boolean } = {},
) {
  return async (args: Args) => {
    await latency();
    const unauth = requireSession();
    if (unauth) return unauth;
    if (args.request.method !== "GET") {
      const csrf = requireCsrf(args.request);
      if (csrf) return csrf;
    }
    if (opts.admin && !isAdmin()) return fail(403, "forbidden", "Only admins can do that.");
    const res = await fn(args);
    if (args.request.method !== "GET") saveDb();
    return res;
  };
}

// ---------------------------------------------------------------- lazy state transitions

function sourceView(s: MockKnowledgeSource): KnowledgeSource {
  const mine = org().knowledgeArticles.filter((a) => a.sourceId === s.id);
  return { ...s, articleCount: mine.length, enabledCount: mine.filter((a) => a.enabled).length };
}

/** A requested knowledge sync finishes a few seconds later (the worker's `sync-knowledge` job in the real API). */
function advanceKnowledge(now: number) {
  for (const s of org().knowledgeSources) {
    if (s.status !== "syncing") continue;
    s.status = "idle";
    s.lastSyncAt = new Date(now).toISOString();
    s.lastError = null;
  }
}

function advanceContracts(now: number) {
  const o = org();
  for (const c of o.contracts) {
    if (c.status !== "extracting" && c.status !== "uploaded") continue;
    const readyAt = new Date(c.uploadedAt).getTime() + 7_000;
    if (now < readyAt) continue;
    const policyId = crypto.randomUUID();
    const base = c.filename
      .replace(/\.(pdf|docx|txt|md)$/i, "")
      .replace(/[—–-]\s*(MSA|Order Form|SLA).*$/i, "")
      .trim();
    const name = base.length > 3 ? base : "Extracted policy";
    const doc = c.filename;
    o.policies.unshift({
      id: policyId,
      name,
      version: 1,
      status: "draft",
      contractId: c.id,
      isDefault: false,
      definition: { ...kestrelDraftDefinition, id: policyId, name },
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
      createdAt: new Date(readyAt).toISOString(),
    });
    c.status = "needs_review";
    c.extraction = {
      summary: `One SLA schedule found in ${doc}: four priorities, business-hours calendar, response and resolution targets, pause rules and service credits.`,
      policyIds: [policyId],
      ambiguities: kestrelAmbiguities.map((a) => ({ ...a })),
      citations: kestrelCitations.map((cit) => ({ ...cit, document: doc })),
    };
    audit(null, "contract.extracted", { type: "contract", id: c.id }, { ambiguities: kestrelAmbiguities.length });
  }
}

function advanceReplays(now: number) {
  const o = org();
  for (const r of o.replays) {
    if (r.status === "succeeded" || r.status === "failed") continue;
    const total = r.progress.ticketsTotal ?? 4_812;
    const elapsed = now - new Date(r.createdAt).getTime();
    const duration = 9_000;
    if (elapsed >= duration) {
      r.status = "succeeded";
      r.progress = { ticketsScanned: total, ticketsTotal: total };
      r.result = replayResult(total);
      audit(null, "replay.completed", { type: "replay", id: r.id }, { days: r.days, breaches: r.result.breaches });
    } else {
      r.status = elapsed < 800 ? "queued" : "running";
      r.progress = {
        ticketsScanned: Math.round((total * Math.max(0, elapsed - 800)) / (duration - 800)),
        ticketsTotal: total,
      };
    }
  }
}

/** Plausible contract text for the demo: each cited quote sits on its cited page among boilerplate clauses. */
function mockContractText(c: Contract): ContractText {
  const citations = c.extraction?.citations ?? [];
  const boiler = [
    "This Schedule forms part of the Agreement between the parties and is subject to its terms.",
    "Capitalised terms not defined here have the meaning given in the Master Services Agreement.",
    "The Supplier shall provide the Support Services with reasonable skill, care and diligence.",
    "Nothing in this Schedule limits either party's rights under clause 14 (Liability).",
  ];
  const paged = citations.some((x) => x.page !== null);
  const last = Math.max(1, ...citations.map((x) => x.page ?? 1));
  const pages: ContractText["pages"] = [];
  for (let n = 1; n <= (paged ? last : 1); n++) {
    const quotes = citations.filter((x) => (paged ? x.page === n : true)).map((x) => x.quote);
    const clauses = [...new Set(quotes)].flatMap((q, i) => [`${n}.${i + 1} ${q}`, boiler[(n + i) % boiler.length]!]);
    pages.push({
      page: paged ? n : null,
      text: [`${c.filename}`, "", boiler[n % boiler.length]!, "", ...clauses.map((x) => `${x}\n`)].join("\n"),
    });
  }
  return { contractId: c.id, filename: c.filename, pages, truncated: false };
}

function customerView(c: ReturnType<typeof org>["customers"][number], now: number): CustomerAccount {
  const o = org();
  const mine = o.tickets.filter((t) => t.customerId === c.id && t.status !== "solved" && t.status !== "closed");
  const risks = mine.map((t) => toSummary(t, now).risk);
  return {
    ...c,
    openTickets: mine.length,
    atRiskTickets: risks.filter((r) => r === "at_risk" || r === "breached").length,
    breachesThisPeriod: c.breachesThisPeriod,
  };
}

/** Mirrors the API's `GET /onboarding`: every step from real (mock) org state. */
function onboardingState(): OnboardingState {
  const o = org();
  const d = getDb();
  const hasDefault = o.policies.some((p) => p.status === "active" && p.isDefault);
  const done: Record<OnboardingStepId, boolean> = {
    connect: o.connections.some((c) => c.status === "active"),
    contract: o.contracts.some((c) => c.status !== "archived"),
    policy: o.policies.some((p) => p.status === "active" && (p.contractId !== null || p.isDefault)),
    assign: hasDefault || o.customers.some((c) => c.policyId !== null),
    autonomy: o.autonomy.length > 0,
    alerts: o.channels.some((c) => c.enabled),
    invite:
      o.members.filter((m) => m.active).length > 1 ||
      (o.invitations ?? []).some((i) => i.status === "pending" || i.status === "accepted"),
    replay: o.replays.some((r) => r.status !== "failed"),
  };
  const steps = ONBOARDING_STEPS.map((id) => ({
    id,
    done: done[id],
    optional: OPTIONAL_ONBOARDING_STEPS.includes(id),
  }));
  const required = steps.filter((x) => !x.optional);
  // People without a record (the seeded demo orgs, older persisted databases) have "used slai before".
  const prefs = o.onboarding?.[d.me.user.id] ?? { checklistDismissed: false, welcomeSeen: true };
  return {
    steps,
    requiredDone: required.filter((x) => x.done).length,
    requiredTotal: required.length,
    allDone: steps.every((x) => x.done),
    checklistDismissed: prefs.checklistDismissed,
    welcomeSeen: prefs.welcomeSeen,
  };
}

// ---------------------------------------------------------------- handlers

/** Sets the org's plan everywhere the app reads it (settings, the session). */
function setPlan(plan: PlanId) {
  const o = org();
  o.billing.plan = plan;
  o.settings.plan = plan;
  getDb().me.organization.plan = plan;
}

/**
 * The mock stands in for Stripe: checkout "completes" at once and the
 * redirect stays in the app (the real API returns a Stripe-hosted URL).
 */
function subscribe(plan: PlanId) {
  const o = org();
  setPlan(plan);
  Object.assign(o.billing, {
    status: "active",
    trialEndsAt: null,
    pastDueSince: null,
    hasCustomer: true,
    hasSubscription: true,
  });
  if (o.billing.invoices.length === 0) o.billing.invoices = buildInvoices(Date.now(), PLANS[plan].priceCents ?? 0);
}

export const handlers = [
  // ------------------------------------------------ auth (mirrors the API's step results and MFA gate)
  http.get(url("/auth/me"), async () => {
    await latency(80, 200);
    const d = getDb();
    if (d.session !== "in") return fail(401, "unauthorized", "Please sign in.");
    return HttpResponse.json(d.me);
  }),

  http.post(url("/auth/discover"), async ({ request }) => {
    await latency(150, 300);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const body = await parse(request, discoverBody);
    if (body instanceof Response) return body;
    const p = ssoProviderFor(body.email);
    const out: SignInDiscovery = p
      ? { method: "sso", providerId: p.provider.providerId, enforced: p.enforced }
      : { method: "password" };
    return HttpResponse.json(out);
  }),

  http.post(url("/auth/sign-in/email"), async ({ request }) => {
    await latency(300, 700);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const body = await parse(request, loginBody);
    if (body instanceof Response) return body;
    const d = getDb();
    if (ssoProviderFor(body.email)?.enforced) {
      return fail(403, "sso_required", "Your organization requires single sign-on. Continue with SSO.");
    }
    if (body.password === "wrong-password")
      return fail(401, "invalid_credentials", "Invalid email, password, or code.");
    const s = d.me.security;
    const methods: SecondFactor[] = [
      ...(s.totp ? (["totp", "backup_code"] as const) : []),
      ...(s.passkeys ? (["passkey"] as const) : []),
    ];
    if (methods.length > 0) {
      d.session = "mfa";
      saveDb();
      return HttpResponse.json({ status: "mfa_required", methods } satisfies SignInResult);
    }
    d.session = "in";
    d.me.security = { ...s, authMethod: "password", mfa: "enrollment_required" };
    saveDb();
    return HttpResponse.json({ status: "mfa_enrollment_required", me: d.me } satisfies SignInResult);
  }),

  http.post(url("/auth/two-factor/verify-totp"), async ({ request }) => {
    await latency(250, 500);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const body = await parse(request, verifyTotpBody);
    if (body instanceof Response) return body;
    const d = getDb();
    if (d.session === "out") return fail(401, "mfa_challenge_expired", "That sign-in attempt expired. Sign in again.");
    if (body.code === "000000") return fail(401, "invalid_code", "That code is not valid.");
    const enrolling = d.session === "in" && !d.me.security.totp;
    d.session = "in";
    d.me.user.mfaEnabled = true;
    // A TOTP code (sign-in or step-up) is fresh proof for sensitive actions for 5 minutes.
    d.me.security = { ...d.me.security, totp: true, mfa: "satisfied", stepUpUntil: stepUpWindow() };
    const member = org().members.find((m) => m.userId === d.me.user.id);
    if (member) member.mfaEnabled = true;
    audit(
      d.me.user.name,
      enrolling ? "auth.mfa_enabled" : "auth.login",
      { type: "user", id: d.me.user.id },
      {
        method: "password",
        secondFactor: "totp",
      },
    );
    saveDb();
    return HttpResponse.json({ status: "signed_in", me: d.me } satisfies SignInResult);
  }),

  http.post(url("/auth/two-factor/verify-backup-code"), async ({ request }) => {
    await latency(250, 500);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const body = await parse(request, verifyBackupCodeBody);
    if (body instanceof Response) return body;
    const d = getDb();
    if (d.session === "out") return fail(401, "mfa_challenge_expired", "That sign-in attempt expired. Sign in again.");
    const i = d.backupCodes.indexOf(body.code);
    if (i === -1) return fail(401, "invalid_code", "That code is not valid.");
    d.backupCodes.splice(i, 1);
    d.session = "in";
    d.me.security = { ...d.me.security, mfa: "satisfied" };
    audit(d.me.user.name, "auth.backup_code_used", { type: "user", id: d.me.user.id });
    saveDb();
    return HttpResponse.json({ status: "signed_in", me: d.me } satisfies SignInResult);
  }),

  http.post(url("/auth/two-factor/enable"), async ({ request }) => {
    await latency(250, 500);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const d = getDb();
    if (d.session !== "in") return fail(401, "unauthorized", "Please sign in.");
    const body = (await request.json().catch(() => ({}))) as { password?: string };
    if (d.me.security.hasPassword && body.password === "wrong-password") {
      return fail(400, "invalid_password", "That password is not correct.");
    }
    const secret = "JBSWY3DPEHPK3PXPKESTREL7Q";
    d.backupCodes = MOCK_BACKUP_CODES.slice();
    saveDb();
    return HttpResponse.json({
      secret,
      otpauthUrl: `otpauth://totp/slai:${encodeURIComponent(d.me.user.email)}?secret=${secret}&issuer=slai&digits=6&period=30`,
      backupCodes: d.backupCodes,
    } satisfies TotpEnrollment);
  }),

  http.post(
    url("/auth/two-factor/generate-backup-codes"),
    guarded(() => {
      const d = getDb();
      d.backupCodes = MOCK_BACKUP_CODES.map((c) => c.replace("mock", "new"));
      audit(d.me.user.name, "auth.backup_codes_regenerated", { type: "user", id: d.me.user.id });
      return HttpResponse.json({ backupCodes: d.backupCodes });
    }),
  ),

  http.post(
    url("/auth/two-factor/disable"),
    guarded(() => {
      const d = getDb();
      if (d.me.security.passkeys === 0) {
        return fail(409, "last_factor", "Add a passkey before removing your authenticator app.");
      }
      d.me.user.mfaEnabled = false;
      d.me.security = { ...d.me.security, totp: false };
      audit(d.me.user.name, "auth.mfa_disabled", { type: "user", id: d.me.user.id });
      return new HttpResponse(null, { status: 204 });
    }),
  ),

  // WebAuthn needs a real authenticator and the real API; mock mode only lists and removes.
  http.get(url("/auth/passkey/generate-register-options"), () =>
    fail(501, "mock_mode", "Passkeys need the real API (mock mode can't run WebAuthn)."),
  ),
  http.get(url("/auth/passkey/generate-authenticate-options"), () =>
    fail(501, "mock_mode", "Passkeys need the real API (mock mode can't run WebAuthn)."),
  ),
  http.get(
    url("/auth/passkey/list-user-passkeys"),
    guarded(() => HttpResponse.json(getDb().passkeys)),
  ),
  http.post(
    url("/auth/passkey/delete-passkey"),
    guarded(async ({ request }) => {
      const d = getDb();
      const { id } = (await request.json()) as { id: string };
      if (!d.me.security.totp && d.passkeys.length <= 1) {
        return fail(409, "last_factor", "Keep at least one second factor.");
      }
      d.passkeys = d.passkeys.filter((p) => p.id !== id);
      d.me.security = { ...d.me.security, passkeys: d.passkeys.length };
      audit(d.me.user.name, "auth.passkey_removed", { type: "passkey", id });
      return new HttpResponse(null, { status: 204 });
    }),
  ),

  http.post(url("/auth/sign-in/sso"), async ({ request }) => {
    await latency(200, 400);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const body = (await request.json().catch(() => ({}))) as { email?: string; providerId?: string; redirect?: string };
    const known = body.email
      ? ssoProviderFor(body.email)
      : Object.values(getDb().orgs)
          .flatMap((o) => o.sso.providers)
          .some((p) => p.providerId === body.providerId && p.domainVerified);
    if (!known) return fail(404, "sso_not_configured", "Single sign-on is not set up for this email domain.");
    // No IdP in mock mode: pretend it signed us in.
    const d = getDb();
    d.session = "in";
    d.me.security = { ...d.me.security, authMethod: "sso", mfa: "satisfied" };
    audit(d.me.user.name, "auth.login", { type: "user", id: d.me.user.id }, { method: "sso" });
    saveDb();
    return HttpResponse.json({ url: body.redirect ?? "/" });
  }),

  http.post(url("/auth/signup"), async ({ request }) => {
    await latency(400, 800);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    const body = await parse(request, signupBody);
    if (body instanceof Response) return body;
    if (body.email.startsWith("taken@"))
      return fail(409, "signup_failed", "Unable to create an account with this email.");
    const d = getDb();
    const orgId = crypto.randomUUID();
    const userId = `u_${orgId.slice(0, 8)}`;
    const owner: Member = {
      userId,
      email: body.email,
      name: body.name,
      role: "owner",
      mfaEnabled: false,
      lastLoginAt: new Date().toISOString(),
      active: true,
      scimManaged: false,
    };
    d.orgs[orgId] = emptyOrg(orgId, body.organizationName, owner, Date.now());
    d.me = {
      user: { id: userId, email: body.email, name: body.name, mfaEnabled: false },
      organization: {
        id: orgId,
        name: body.organizationName,
        slug: body.organizationName.toLowerCase().replace(/\W+/g, "-"),
        plan: TRIAL.plan,
      },
      role: "owner",
      organizations: [{ id: orgId, name: body.organizationName, role: "owner" }],
      security: {
        authMethod: "password",
        mfa: "enrollment_required",
        totp: false,
        passkeys: 0,
        hasPassword: true,
        stepUpUntil: null,
      },
    };
    d.passkeys = [];
    d.session = "in";
    audit(body.name, "auth.signup", { type: "organization", id: orgId });
    saveDb();
    return HttpResponse.json({ status: "mfa_enrollment_required", me: d.me } satisfies SignInResult, { status: 201 });
  }),

  http.post(url("/auth/logout"), async ({ request }) => {
    await latency(80, 160);
    const csrf = requireCsrf(request);
    if (csrf) return csrf;
    getDb().session = "out";
    saveDb();
    return new HttpResponse(null, { status: 204 });
  }),

  // ------------------------------------------------ org SSO (admins)
  http.get(
    url("/org/sso"),
    guarded(() => HttpResponse.json(org().sso), { admin: true }),
  ),
  http.patch(
    url("/org/sso"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, updateOrgSsoBody);
        if (body instanceof Response) return body;
        const o = org();
        if (body.enforceSso && !o.sso.providers.some((p) => p.domainVerified)) {
          return fail(409, "sso_not_ready", "Verify a domain for an SSO provider before enforcing SSO.");
        }
        o.sso = {
          ...o.sso,
          ...(body.enforceSso !== undefined && { enforceSso: body.enforceSso }),
          ...(body.requireMfaForSso !== undefined && { requireMfaForSso: body.requireMfaForSso }),
          ...(body.requireIdpMfa !== undefined && { requireIdpMfa: body.requireIdpMfa }),
        };
        audit(actor(), "sso.settings_changed", { type: "organization", id: o.settings.id }, body);
        return HttpResponse.json(o.sso);
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/org/sso/providers"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, createSsoProviderBody);
        if (body instanceof Response) return body;
        const providerId = `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
        const base = "http://localhost:8787/api/v1/auth/sso";
        const p: SsoProvider = {
          id: crypto.randomUUID(),
          providerId,
          name: body.name,
          protocol: body.protocol,
          issuer: body.protocol === "oidc" ? body.issuer : "https://idp.example/entity",
          domains: body.domains,
          domainVerified: false,
          domainVerification: {
            recordName: "_slai-verification",
            recordValue: `slai-verification=${crypto.randomUUID().slice(0, 18)}`,
          },
          clientId: body.protocol === "oidc" ? body.clientId : null,
          metadataUrl: body.protocol === "saml" ? (body.metadataUrl ?? null) : null,
          callbackUrl:
            body.protocol === "oidc" ? `${base}/callback/${providerId}` : `${base}/saml2/sp/acs/${providerId}`,
          createdAt: new Date().toISOString(),
        };
        org().sso.providers.push(p);
        audit(actor(), "sso.provider_created", { type: "sso_provider", id: p.id }, { protocol: p.protocol });
        return HttpResponse.json(p, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/org/sso/providers/:id/verify-domain"),
    guarded(
      ({ params }) => {
        const p = org().sso.providers.find((x) => x.id === params.id);
        if (!p) return fail(404, "not_found", "SSO provider not found.");
        p.domainVerified = true;
        p.domainVerification = null;
        audit(actor(), "sso.domain_verified", { type: "sso_provider", id: p.id });
        return HttpResponse.json(p);
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/org/sso/providers/:id"),
    guarded(
      ({ params }) => {
        const o = org();
        o.sso.providers = o.sso.providers.filter((x) => x.id !== params.id);
        if (!o.sso.providers.some((p) => p.domainVerified)) o.sso.enforceSso = false;
        audit(actor(), "sso.provider_deleted", { type: "sso_provider", id: String(params.id) });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),

  http.post(
    url("/auth/switch-org"),
    guarded(async ({ request }) => {
      const body = await parse(request, switchOrgBody);
      if (body instanceof Response) return body;
      const { organizationId } = body;
      const d = getDb();
      const target = d.me.organizations.find((o) => o.id === organizationId);
      if (!target || !d.orgs[organizationId]) return fail(404, "not_found", "Organization not found.");
      const settings = d.orgs[organizationId]!.settings;
      d.me = {
        ...d.me,
        organization: {
          id: organizationId,
          name: settings.name,
          slug: settings.name.toLowerCase().replace(/\W+/g, "-"),
          plan: settings.plan,
        },
        role: target.role,
      };
      return HttpResponse.json(d.me);
    }),
  ),

  // Demo-only: reset the dataset.
  http.post(url("/__mock/reset"), async () => {
    resetDb();
    return new HttpResponse(null, { status: 204 });
  }),

  // ------------------------------------------------ org & members
  http.get(
    url("/org"),
    guarded(() => HttpResponse.json(org().settings)),
  ),
  http.patch(
    url("/org"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, updateOrgBody);
        if (body instanceof Response) return body;
        const o = org();
        Object.assign(o.settings, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
        const d = getDb();
        if (body.name) {
          d.me.organization.name = body.name;
          const entry = d.me.organizations.find((x) => x.id === o.settings.id);
          if (entry) entry.name = body.name;
        }
        audit(actor(), "org.updated", { type: "organization", id: o.settings.id }, body);
        return HttpResponse.json(o.settings);
      },
      { admin: true },
    ),
  ),
  // ------------------------------------------------ offboarding (owner; in memory only)
  http.get(
    url("/org/offboarding"),
    guarded(() => HttpResponse.json(offboardingFor(org().settings.id))),
  ),
  http.post(
    url("/org/exports"),
    guarded(() => {
      const state = offboardingFor(org().settings.id);
      const now = new Date();
      const e: OrgExport = {
        id: crypto.randomUUID(),
        status: "succeeded",
        sizeBytes: 48_213,
        sha256: "0".repeat(64),
        error: null,
        requestedBy: getDb().me.user.email,
        createdAt: now.toISOString(),
        finishedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      };
      state.exports.unshift(e);
      audit(actor(), "org.export.requested", { type: "org_export", id: e.id });
      return HttpResponse.json(e, { status: 202 });
    }),
  ),
  http.post(
    url("/org/deletion"),
    guarded(async ({ request }) => {
      const body = await parse(request, scheduleDeletionBody);
      if (body instanceof Response) return body;
      const o = org();
      if (body.confirmName.trim() !== o.settings.name.trim())
        return fail(400, "invalid_request", "Type the organization's name exactly to confirm.");
      const state = offboardingFor(o.settings.id);
      const now = new Date();
      state.deletion = {
        scheduledFor: new Date(now.getTime() + state.graceDays * 86_400_000).toISOString(),
        requestedAt: now.toISOString(),
        requestedBy: getDb().me.user.email,
      };
      audit(actor(), "org.deletion.scheduled", { type: "organization", id: o.settings.id });
      return HttpResponse.json(state);
    }),
  ),
  http.delete(
    url("/org/deletion"),
    guarded(() => {
      const o = org();
      const state = offboardingFor(o.settings.id);
      state.deletion = null;
      audit(actor(), "org.deletion.cancelled", { type: "organization", id: o.settings.id });
      return HttpResponse.json(state);
    }),
  ),
  http.get(
    url("/members"),
    guarded(() => HttpResponse.json(list(org().members))),
  ),
  http.post(
    url("/members/invite"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, inviteBody);
        if (body instanceof Response) return body;
        const o = org();
        if (o.members.some((m) => m.email === body.email))
          return fail(409, "already_member", `${body.email} is already a member.`);
        const now = Date.now();
        const invitation: Invitation = {
          id: crypto.randomUUID(),
          email: body.email,
          role: body.role,
          expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
          status: "pending",
          createdAt: new Date(now).toISOString(),
          invitedBy: actor(),
        };
        o.invitations = [invitation, ...(o.invitations ?? [])];
        audit(actor(), "member.invited", { type: "invitation", id: invitation.id }, body);
        return HttpResponse.json(invitation, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.get(
    url("/members/invitations"),
    guarded(() => HttpResponse.json(list(org().invitations ?? [])), { admin: true }),
  ),
  http.post(
    url("/members/invitations/:id/resend"),
    guarded(
      ({ params }) => {
        const inv = (org().invitations ?? []).find((i) => i.id === params.id);
        if (!inv) return fail(404, "not_found", "Invitation not found.");
        if (inv.status === "accepted" || inv.status === "revoked")
          return fail(409, "invitation_closed", "This invitation was already used or revoked.");
        inv.status = "pending";
        inv.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        audit(actor(), "member.invitation_resent", { type: "invitation", id: inv.id }, { email: inv.email });
        return HttpResponse.json(inv);
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/members/invitations/:id"),
    guarded(
      ({ params }) => {
        const inv = (org().invitations ?? []).find((i) => i.id === params.id && i.status === "pending");
        if (!inv) return fail(404, "not_found", "Invitation not found.");
        inv.status = "revoked";
        audit(actor(), "member.invitation_revoked", { type: "invitation", id: inv.id }, { email: inv.email });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),
  // The invitee's page in mock mode: any token previews a pending invitation to the demo org.
  http.get(url("/auth/invitations/:token"), async () => {
    await latency();
    const preview: InvitationPreview = {
      organization: { name: org().settings.name },
      email: "new.teammate@example.com",
      role: "member",
      invitedBy: getDb().me.user.name,
      expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      status: "pending",
      account: "new",
      sso: null,
    };
    return HttpResponse.json(preview);
  }),
  http.post(url("/auth/invitations/:token/signup"), () =>
    fail(501, "mock_mode", "Accepting invitations needs the real API."),
  ),
  http.post(url("/auth/invitations/:token/accept"), () =>
    fail(501, "mock_mode", "Accepting invitations needs the real API."),
  ),
  http.patch(
    url("/members/:userId"),
    guarded(async ({ request, params }) => {
      if (getDb().me.role !== "owner") return fail(403, "forbidden", "Only the owner can change roles.");
      const body = await parse(request, updateMemberBody);
      if (body instanceof Response) return body;
      const { role } = body;
      const m = org().members.find((x) => x.userId === params.userId);
      if (!m) return fail(404, "not_found", "Member not found.");
      if (m.role === "owner") return fail(409, "last_owner", "The owner's role can't be changed here.");
      m.role = role;
      audit(actor(), "member.role_changed", { type: "member", id: m.userId }, { role });
      return HttpResponse.json(m);
    }),
  ),
  http.delete(
    url("/members/:userId"),
    guarded(
      ({ params }) => {
        const o = org();
        const m = o.members.find((x) => x.userId === params.userId);
        if (!m) return fail(404, "not_found", "Member not found.");
        if (m.role === "owner") return fail(409, "last_owner", "The owner can't be removed.");
        o.members = o.members.filter((x) => x !== m);
        audit(actor(), "member.removed", { type: "member", id: m.userId }, { email: m.email });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),

  http.post(
    url("/members/:userId/reset-mfa"),
    guarded(
      async ({ request, params }) => {
        const body = await parse(request, resetMemberMfaBody);
        if (body instanceof Response) return body;
        if (!stepUpFresh()) {
          const s = getDb().me.security;
          const methods: SecondFactor[] = [
            ...(s.totp ? ["totp" as const] : []),
            ...(s.passkeys ? ["passkey" as const] : []),
          ];
          return fail(403, "step_up_required", "Confirm it's you: enter a code from your authenticator app.", {
            methods,
          });
        }
        const m = org().members.find((x) => x.userId === params.userId);
        if (!m) return fail(404, "not_found", "Member not found.");
        if (m.userId === actorId()) return fail(409, "self_reset", "Use Settings → Security for your own two-factor.");
        if (m.role === "owner" && getDb().me.role !== "owner") {
          return fail(403, "cannot_reset_owner", "Only an owner can reset an owner's two-factor.");
        }
        const hadTotp = m.mfaEnabled;
        m.mfaEnabled = false;
        audit(actor(), "member.mfa_reset", { type: "user", id: m.userId }, { reason: body.reason });
        return HttpResponse.json({ userId: m.userId, removed: { totp: hadTotp, passkeys: 0 }, sessionsRevoked: 1 });
      },
      { admin: true },
    ),
  ),
  http.get(url("/auth/step-up/passkey-options"), () =>
    fail(501, "mock_mode", "Passkeys need the real API (mock mode can't run WebAuthn)."),
  ),

  // ------------------------------------------------ SCIM settings (admins)
  http.get(
    url("/org/scim"),
    guarded(() => HttpResponse.json(scim()), { admin: true }),
  ),
  http.post(
    url("/org/scim/tokens"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, createScimTokenBody);
        if (body instanceof Response) return body;
        if (!org().sso.providers.some((p) => p.domainVerified)) {
          return fail(409, "sso_not_ready", "Verify a domain for an SSO provider before turning on SCIM.");
        }
        const token = `slai_scim_${crypto.randomUUID().replace(/-/g, "")}mock`;
        const created: ScimTokenCreated = {
          id: crypto.randomUUID(),
          name: body.name,
          prefix: token.slice(0, 14),
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
          token,
        };
        const { token: _shownOnce, ...stored } = created;
        scim().tokens.push(stored);
        audit(actor(), "scim.token_created", { type: "scim_token", id: created.id }, { name: body.name });
        return HttpResponse.json(created, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/org/scim/tokens/:id"),
    guarded(
      ({ params }) => {
        const t = scim().tokens.find((x) => x.id === params.id && !x.revokedAt);
        if (!t) return fail(404, "not_found", "SCIM token not found.");
        t.revokedAt = new Date().toISOString();
        audit(actor(), "scim.token_revoked", { type: "scim_token", id: t.id }, { name: t.name });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/org/scim/group-roles"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, scimGroupRoleBody);
        if (body instanceof Response) return body;
        const s = scim();
        const existing = s.groupRoles.find((g) => g.groupName.toLowerCase() === body.groupName.toLowerCase());
        const mapping = existing ?? { id: crypto.randomUUID(), groupName: body.groupName, role: body.role };
        mapping.role = body.role;
        if (!existing) s.groupRoles.push(mapping);
        audit(actor(), "scim.group_role_mapped", { type: "scim_group_role", id: mapping.id }, body);
        return HttpResponse.json(mapping, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/org/scim/group-roles/:id"),
    guarded(
      ({ params }) => {
        const s = scim();
        if (!s.groupRoles.some((g) => g.id === params.id)) return fail(404, "not_found", "Group mapping not found.");
        s.groupRoles = s.groupRoles.filter((g) => g.id !== params.id);
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),

  // ------------------------------------------------ connectors & connections
  http.get(
    url("/connectors"),
    guarded(() => HttpResponse.json(CONNECTORS)),
  ),
  http.get(
    url("/connections"),
    guarded(() => HttpResponse.json(list(org().connections))),
  ),
  http.get(
    url("/connections/:id"),
    guarded(({ params }) => {
      const c = org().connections.find((x) => x.id === params.id);
      return c ? HttpResponse.json(c) : fail(404, "not_found", "Connection not found.");
    }),
  ),
  http.post(
    url("/connections"),
    guarded(
      async ({ request }) => {
        await latency(600, 1200);
        const body = await parse(request, createConnectionBody);
        if (body instanceof Response) return body;
        const info = CONNECTORS.find((c) => c.provider === body.provider);
        if (!info) return fail(400, "unknown_provider", `Unknown help desk "${body.provider}".`);
        const missing = info.fields.filter((f) => f.secret && !body.credentials[f.key]);
        if (missing.length && info.authKind !== "oauth2")
          return fail(
            400,
            "validation_failed",
            "Some fields are required.",
            missing.map((f) => ({ path: [f.key], message: "Required" })),
          );
        if (Object.values(body.credentials).some((v) => v === "bad" || v === "invalid"))
          return fail(422, "invalid_credentials", `${info.displayName} rejected these credentials (401 Unauthorized).`);
        const o = org();
        const id = crypto.randomUUID();
        const conn: Connection = {
          id,
          provider: body.provider,
          name: body.name,
          status: "active",
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          mappingIssues: [],
          webhookUrl: info.supportsWebhooks ? `https://hooks.slai.example/v1/webhooks/${id}` : null,
          ticketCount: 0,
          createdAt: new Date().toISOString(),
        };
        // A brand-new org gets a realistic backlog once its first help desk connects.
        if (o.tickets.length === 0) {
          const now = Date.now();
          o.customers = buildCustomers().map((c) => ({ ...c, policyId: null }));
          o.tickets = buildTickets(now, o.customers).map((t) => ({
            ...t,
            connectionId: id,
            provider: body.provider,
            policyId: null,
          }));
          conn.ticketCount = 3_906;
        }
        o.connections.push(conn);
        audit(actor(), "connection.created", { type: "connection", id }, { provider: body.provider });
        return HttpResponse.json(conn, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/connections/:id"),
    guarded(
      ({ params }) => {
        const o = org();
        o.connections = o.connections.filter((c) => c.id !== params.id);
        audit(actor(), "connection.deleted", { type: "connection", id: String(params.id) });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/connections/:id/test"),
    guarded(async ({ params }) => {
      await latency(500, 900);
      const c = org().connections.find((x) => x.id === params.id);
      if (!c) return fail(404, "not_found", "Connection not found.");
      if (c.status === "error")
        return fail(502, "upstream_unauthorized", c.lastError ?? "The help desk rejected our credentials.");
      return HttpResponse.json({ ok: true, accountName: `${getDb().me.organization.name} (${c.provider})` });
    }),
  ),
  http.post(
    url("/connections/:id/sync"),
    guarded(({ params }) => {
      const c = org().connections.find((x) => x.id === params.id);
      if (!c) return fail(404, "not_found", "Connection not found.");
      c.lastSyncAt = new Date().toISOString();
      return new HttpResponse(null, { status: 202 });
    }),
  ),

  http.get(
    url("/connections/:id/mapping"),
    guarded(({ params }) => {
      const c = org().connections.find((x) => x.id === params.id);
      if (!c) return fail(404, "not_found", "Connection not found.");
      return HttpResponse.json(mockMapping(c));
    }),
  ),
  http.put(
    url("/connections/:id/mapping"),
    guarded(
      async ({ request, params }) => {
        const c = org().connections.find((x) => x.id === params.id);
        if (!c) return fail(404, "not_found", "Connection not found.");
        const body = await parse(request, updateMappingBody);
        if (body instanceof Response) return body;
        MOCK_OVERRIDES.set(c.id, body);
        const m = { status: { ...MOCK_DEFAULT_MAPPING.status, ...body.status }, priority: { ...body.priority } };
        c.mappingIssues = c.mappingIssues.filter((i) => !(i.raw in m[i.field]));
        audit(actor(), "connection.mapping_updated", { type: "connection", id: c.id });
        return HttpResponse.json(mockMapping(c));
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/connections/:id/webhook-secret/reveal"),
    guarded(
      ({ params }) => {
        const c = org().connections.find((x) => x.id === params.id);
        if (!c?.webhookUrl) return fail(404, "not_found", "Connection not found.");
        audit(actor(), "connection.webhook_secret_revealed", { type: "connection", id: c.id });
        return HttpResponse.json({
          webhookUrl: c.webhookUrl,
          secretSource: "slai",
          secret: `whsec_mock_${c.id.slice(0, 8)}`,
          configured: true,
          steps: [
            "In your help desk, create a webhook that POSTs JSON to {url}.",
            "Add the header X-Slai-Webhook-Secret: {secret}, then trigger it on ticket create and update.",
          ],
        });
      },
      { admin: true },
    ),
  ),

  // ------------------------------------------------ customers
  http.get(
    url("/customers"),
    guarded(() => {
      const now = Date.now();
      return HttpResponse.json(list(org().customers.map((c) => customerView(c, now))));
    }),
  ),
  http.post(
    url("/customers"),
    guarded(async ({ request }) => {
      const body = await parse(request, upsertCustomerBody);
      if (body instanceof Response) return body;
      const c = { id: crypto.randomUUID(), ...body, breachesThisPeriod: 0 };
      org().customers.push(c);
      audit(actor(), "customer.created", { type: "customer", id: c.id }, { name: c.name });
      return HttpResponse.json(customerView(c, Date.now()), { status: 201 });
    }),
  ),
  http.patch(
    url("/customers/:id"),
    guarded(async ({ request, params }) => {
      const body = await parse(request, upsertCustomerBody.partial());
      if (body instanceof Response) return body;
      const c = org().customers.find((x) => x.id === params.id);
      if (!c) return fail(404, "not_found", "Customer not found.");
      Object.assign(c, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      audit(actor(), "customer.updated", { type: "customer", id: c.id }, body);
      return HttpResponse.json(customerView(c, Date.now()));
    }),
  ),
  http.delete(
    url("/customers/:id"),
    guarded(({ params }) => {
      const o = org();
      o.customers = o.customers.filter((c) => c.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  ),

  // ------------------------------------------------ contracts
  http.get(
    url("/contracts"),
    guarded(() => {
      advanceContracts(Date.now());
      return HttpResponse.json(list(org().contracts));
    }),
  ),
  http.get(
    url("/contracts/:id"),
    guarded(({ params }) => {
      advanceContracts(Date.now());
      const c = org().contracts.find((x) => x.id === params.id);
      return c ? HttpResponse.json(c) : fail(404, "not_found", "Contract not found.");
    }),
  ),
  http.get(
    url("/contracts/:id/text"),
    guarded(({ params }) => {
      const c = org().contracts.find((x) => x.id === params.id);
      if (!c) return fail(404, "not_found", "Contract not found.");
      return HttpResponse.json(mockContractText(c));
    }),
  ),
  http.get(url("/contracts/:id/file"), async ({ params }) => {
    const c = org().contracts.find((x) => x.id === params.id);
    if (!c) return fail(404, "not_found", "Contract not found.");
    const text = (c.extraction?.citations ?? []).map((x) => `[p.${x.page ?? "?"}] ${x.quote}`).join("\n\n");
    return new HttpResponse(`${c.filename}\n\n${text || "(original file)"}`, {
      headers: { "content-type": "text/plain" },
    });
  }),
  http.post(
    url("/contracts"),
    guarded(async ({ request }) => {
      await latency(500, 900);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return fail(400, "validation_failed", "Attach a file.");
      if (!/\.(pdf|docx|txt|md)$/i.test(file.name))
        return fail(415, "unsupported_type", "Upload a PDF, DOCX, TXT or Markdown file.");
      if (file.size > 20 * 1024 * 1024) return fail(413, "too_large", "Contracts must be 20 MB or smaller.");
      const customerAccountId = (form.get("customerAccountId") as string | null) || null;
      const contract: Contract = {
        id: crypto.randomUUID(),
        filename: file.name,
        customerAccountId,
        status: "extracting",
        uploadedAt: new Date().toISOString(),
        uploadedBy: actorId(),
        uploadedByName: actor(),
        error: null,
        extraction: null,
      };
      org().contracts.unshift(contract);
      audit(actor(), "contract.uploaded", { type: "contract", id: contract.id }, { filename: file.name });
      return HttpResponse.json(contract, { status: 201 });
    }),
  ),
  http.post(
    url("/contracts/:id/extract"),
    guarded(({ params }) => {
      const c = org().contracts.find((x) => x.id === params.id);
      if (!c) return fail(404, "not_found", "Contract not found.");
      c.status = "extracting";
      c.error = null;
      c.uploadedAt = new Date().toISOString();
      return new HttpResponse(null, { status: 202 });
    }),
  ),

  // ------------------------------------------------ policies
  http.get(
    url("/policies"),
    guarded(() => HttpResponse.json(list(org().policies))),
  ),
  http.get(
    url("/policies/:id"),
    guarded(({ params }) => {
      advanceContracts(Date.now());
      const p = org().policies.find((x) => x.id === params.id);
      return p ? HttpResponse.json(p) : fail(404, "not_found", "Policy not found.");
    }),
  ),
  http.post(
    url("/policies"),
    guarded(async ({ request }) => {
      const body = await parse(request, createPolicyBody);
      if (body instanceof Response) return body;
      const base = body.basedOn ? org().policies.find((x) => x.id === body.basedOn) : undefined;
      const p: Policy = {
        id: crypto.randomUUID(),
        name: body.name,
        version: base ? base.version + 1 : 1,
        status: "draft",
        contractId: body.contractId ?? base?.contractId ?? null,
        isDefault: body.isDefault,
        definition: body.definition,
        approvedBy: null,
        approvedByName: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
      };
      org().policies.unshift(p);
      return HttpResponse.json(p, { status: 201 });
    }),
  ),
  http.patch(
    url("/policies/:id"),
    guarded(async ({ request, params }) => {
      const body = await parse(request, updatePolicyBody);
      if (body instanceof Response) return body;
      const o = org();
      const p = o.policies.find((x) => x.id === params.id);
      if (!p) return fail(404, "not_found", "Policy not found.");
      if (body.isDefault !== undefined) {
        if (p.status !== "active") return fail(409, "not_active", "Only an active policy can be the default.");
        for (const x of o.policies) x.isDefault = false;
        p.isDefault = body.isDefault;
        audit(actor(), "policy.default_changed", { type: "policy", id: p.id }, { name: p.name });
        return HttpResponse.json(p);
      }
      if (p.status !== "draft")
        return fail(409, "policy_not_draft", "Only draft policies can be edited. Create a new version instead.");
      if (body.name) p.name = body.name;
      if (body.definition !== undefined) p.definition = body.definition;
      return HttpResponse.json(p);
    }),
  ),
  http.post(
    url("/policies/:id/approve"),
    guarded(
      ({ params }) => {
        const o = org();
        const p = o.policies.find((x) => x.id === params.id);
        if (!p) return fail(404, "not_found", "Policy not found.");
        if (p.status !== "draft") return fail(409, "policy_not_draft", "This policy is not a draft.");
        for (const x of o.policies)
          if (x.status === "active" && x.name === p.name && x.id !== p.id) x.status = "superseded";
        p.status = "active";
        p.approvedBy = actorId();
        p.approvedByName = actor();
        p.approvedAt = new Date().toISOString();
        const contract = o.contracts.find((c) => c.id === p.contractId);
        if (contract?.extraction?.policyIds.every((id) => o.policies.find((x) => x.id === id)?.status === "active")) {
          contract.status = "approved";
          const customer = o.customers.find((c) => c.id === contract.customerAccountId);
          if (customer) customer.policyId = p.id;
        }
        audit(actor(), "policy.approved", { type: "policy", id: p.id }, { name: p.name, version: p.version });
        return HttpResponse.json(p);
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/policies/:id/archive"),
    guarded(({ params }) => {
      const p = org().policies.find((x) => x.id === params.id);
      if (!p) return fail(404, "not_found", "Policy not found.");
      p.status = "archived";
      p.isDefault = false;
      audit(actor(), "policy.archived", { type: "policy", id: p.id });
      return HttpResponse.json(p);
    }),
  ),
  http.post(
    url("/policies/:id/preview"),
    guarded(async ({ request }) => {
      await latency(900, 1600);
      const body = await parse(request, policyPreviewBody);
      if (body instanceof Response) return body;
      const days = body.days;
      const scale = days / 90;
      org().usageExtraCents += 30;
      return HttpResponse.json({
        days,
        tickets: Math.round(4_812 * scale),
        breaches: Math.round(61 * scale),
        attainmentPercent: 98.4,
        exposureCents: Math.round(1_540_000 * scale),
      });
    }),
  ),

  // ------------------------------------------------ tickets
  http.get(
    url("/tickets"),
    guarded(({ request }) => {
      const now = Date.now();
      const q = new URL(request.url).searchParams;
      const risk = q.get("risk");
      const status = q.get("status");
      const customerId = q.get("customerId");
      const text = q.get("q")?.toLowerCase().trim();
      const offset = Number(q.get("cursor") ?? 0) || 0;
      const limit = 25;
      let items = org().tickets.map((t) => toSummary(t, now));
      if (risk) items = items.filter((t) => t.risk === risk);
      if (status) items = items.filter((t) => t.status === status);
      if (customerId) items = items.filter((t) => t.customer?.id === customerId);
      if (text)
        items = items.filter(
          (t) =>
            t.subject.toLowerCase().includes(text) ||
            t.displayKey.toLowerCase().includes(text) ||
            (t.customer?.name.toLowerCase().includes(text) ?? false),
        );
      const key = (t: (typeof items)[number]) =>
        t.next === null
          ? Number.POSITIVE_INFINITY
          : t.next.state === "paused"
            ? 1e15 + (t.next.remainingMs ?? 0)
            : (t.next.remainingMs ?? 0);
      items.sort((a, b) => key(a) - key(b));
      const page = items.slice(offset, offset + limit);
      return HttpResponse.json(list(page, offset + limit < items.length ? String(offset + limit) : null));
    }),
  ),
  http.get(
    url("/tickets/:id"),
    guarded(({ params }) => {
      const t = org().tickets.find((x) => x.id === params.id);
      return t ? HttpResponse.json(toDetail(t, Date.now())) : fail(404, "not_found", "Ticket not found.");
    }),
  ),
  http.post(
    url("/tickets/:id/agents/:kind"),
    guarded(async ({ params }) => {
      await latency(700, 1400);
      const o = org();
      const t = o.tickets.find((x) => x.id === params.id);
      if (!t) return fail(404, "not_found", "Ticket not found.");
      const kind = params.kind === "triage" ? "triage" : "draft_reply";
      const now = Date.now();
      const run = {
        id: crypto.randomUUID(),
        kind,
        status: "succeeded",
        model: kind === "triage" ? "claude-haiku" : "claude-sonnet",
        costCents: kind === "triage" ? 1 : 6,
        sandboxSeconds: kind === "triage" ? 3.9 : 12.4,
        startedAt: new Date(now - 12_000).toISOString(),
        finishedAt: new Date(now).toISOString(),
        error: null,
        output: { confidence: 0.87 },
      } as const;
      t.agentRuns.push({ ...run });
      o.usageExtraCents += run.costCents;
      if (kind === "draft_reply") {
        const first = t.requester.name?.split(" ")[0] ?? "there";
        o.actions.unshift({
          id: crypto.randomUUID(),
          ticketId: t.id,
          ticketKey: t.displayKey,
          ticketSubject: t.subject,
          kind: "public_reply",
          status: "proposed",
          body: `Hi ${first},\n\nThanks for your patience while we looked into this. Our engineers have identified the cause and a fix is rolling out now. I'll confirm here as soon as it's complete, and within the next hour either way.\n\n${t.assigneeName ?? "The support team"}`,
          payload: {},
          usedKnowledge: knowledgeRefsFor(t.subject).filter((r) =>
            o.knowledgeArticles.some((a) => a.id === r.id && a.enabled),
          ),
          confidence: 0.87,
          blockedReason: null,
          createdAt: new Date(now).toISOString(),
          decidedBy: null,
          decidedByName: null,
          decidedAt: null,
        });
      }
      t.timeline.push({
        at: new Date(now).toISOString(),
        type: "agent_run",
        label: kind === "triage" ? "Triage re-run by agent" : "Draft reply ready for approval",
        author: "slai agent",
      });
      return HttpResponse.json(run, { status: 201 });
    }),
  ),

  // ------------------------------------------------ actions
  http.get(
    url("/actions"),
    guarded(({ request }) => {
      const status = new URL(request.url).searchParams.get("status");
      const items = org().actions.filter((a) => !status || a.status === status);
      return HttpResponse.json(list(items));
    }),
  ),
  http.post(
    url("/actions/:id/approve"),
    guarded(async ({ request, params }) => {
      const body = await parse(request, approveActionBody);
      if (body instanceof Response) return body;
      const o = org();
      const a = o.actions.find((x) => x.id === params.id);
      if (!a) return fail(404, "not_found", "Draft not found.");
      if (a.status !== "proposed" && a.status !== "blocked")
        return fail(409, "already_decided", "This draft was already decided.");
      const edited = body.body !== undefined && body.body !== a.body;
      if (body.body !== undefined) a.body = body.body;
      a.status = "sent";
      a.decidedBy = actorId();
      a.decidedByName = actor();
      a.decidedAt = new Date().toISOString();
      const t = o.tickets.find((x) => x.id === a.ticketId);
      if (t) {
        const now = Date.now();
        t.timeline.push({
          at: new Date(now).toISOString(),
          type: "comment",
          label: a.body ?? "",
          author: actor(),
          public: a.kind === "public_reply",
        });
        t.updatedAt = now;
        if (a.kind === "public_reply") {
          for (const m of t.metrics) {
            if (
              (m.metric === "first_response" || m.metric === "next_response") &&
              m.state === "running" &&
              m.targetMs
            ) {
              const remaining = (m.dueAt ?? now) - now;
              m.state = "achieved";
              m.frozenElapsedMs = m.targetMs - remaining;
              if (remaining < 0) m.breachCount = 1;
              m.dueAt = null;
            }
          }
          if (t.status === "new") t.status = "open";
        }
      }
      audit(actor(), "action.approved", { type: "agent_action", id: a.id }, { ticket: a.ticketKey, edited });
      return HttpResponse.json(a satisfies AgentAction);
    }),
  ),
  http.post(
    url("/actions/:id/reject"),
    guarded(async ({ request, params }) => {
      const body = await parse(request, rejectActionBody);
      if (body instanceof Response) return body;
      const a = org().actions.find((x) => x.id === params.id);
      if (!a) return fail(404, "not_found", "Draft not found.");
      if (a.status !== "proposed" && a.status !== "blocked")
        return fail(409, "already_decided", "This draft was already decided.");
      a.status = "rejected";
      a.decidedBy = actorId();
      a.decidedByName = actor();
      a.decidedAt = new Date().toISOString();
      audit(actor(), "action.rejected", { type: "agent_action", id: a.id }, { reason: body.reason ?? null });
      return HttpResponse.json(a);
    }),
  ),

  // ------------------------------------------------ knowledge (T-47)
  http.get(
    url("/knowledge-sources"),
    guarded(() => {
      advanceKnowledge(Date.now());
      return HttpResponse.json(list(org().knowledgeSources.map(sourceView)));
    }),
  ),
  http.post(
    url("/knowledge-sources"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, createKnowledgeSourceBody);
        if (body instanceof Response) return body;
        const o = org();
        if (body.kind === "manual") {
          if (body.connectionId) return fail(400, "invalid_request", "Saved replies don't belong to a connection.");
          if (o.knowledgeSources.some((s) => s.kind === "manual"))
            return fail(409, "conflict", "Your organization already has a saved-replies source.");
        } else {
          const conn = o.connections.find((c) => c.id === body.connectionId);
          if (!conn) return fail(400, "invalid_request", "Choose a connected help desk.");
          const def = CONNECTORS.find((c) => c.provider === conn.provider);
          if (body.kind === "saved_replies" ? !def?.supportsSavedReplies : !def?.supportsKnowledge)
            return fail(
              400,
              "invalid_request",
              body.kind === "saved_replies"
                ? "This help desk has no saved replies slai can sync."
                : "This help desk has no help center slai can sync.",
            );
          if (o.knowledgeSources.some((s) => s.connectionId === conn.id && s.kind === body.kind))
            return fail(409, "conflict", "This help desk is already a knowledge source.");
        }
        const src: MockKnowledgeSource = {
          id: crypto.randomUUID(),
          connectionId: body.connectionId,
          kind: body.kind,
          name: body.name,
          status: body.kind === "manual" ? "idle" : "syncing",
          lastSyncAt: null,
          lastError: null,
          createdAt: new Date().toISOString(),
        };
        o.knowledgeSources.push(src);
        audit(actor(), "knowledge_source.created", { type: "knowledge_source", id: src.id }, { kind: src.kind });
        return HttpResponse.json(sourceView(src), { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/knowledge-sources/:id/sync"),
    guarded(
      ({ params }) => {
        const src = org().knowledgeSources.find((s) => s.id === params.id);
        if (!src) return fail(404, "not_found", "Knowledge source not found.");
        if (src.kind === "manual") return fail(400, "invalid_request", "Saved replies are not synced.");
        src.status = "syncing";
        src.lastError = null;
        audit(actor(), "knowledge_source.sync_requested", { type: "knowledge_source", id: src.id });
        return HttpResponse.json({ queued: true }, { status: 202 });
      },
      { admin: true },
    ),
  ),
  http.get(
    url("/knowledge-articles"),
    guarded(({ request }) => {
      const r = knowledgeArticleQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!r.success) return fail(400, "invalid_query", "Query parameters are invalid.", r.error.issues);
      const { q, sourceId, cursor, limit } = r.data;
      const all = org()
        .knowledgeArticles.filter((a) => (!sourceId || a.sourceId === sourceId) && matchesArticle(a, q))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = Number(cursor ?? 0) || 0;
      const page = all.slice(offset, offset + limit);
      return HttpResponse.json(list(page, offset + limit < all.length ? String(offset + limit) : null));
    }),
  ),
  http.patch(
    url("/knowledge-articles/:id"),
    guarded(
      async ({ request, params }) => {
        const body = await parse(request, updateKnowledgeArticleBody);
        if (body instanceof Response) return body;
        const a = org().knowledgeArticles.find((x) => x.id === params.id);
        if (!a) return fail(404, "not_found", "Article not found.");
        a.enabled = body.enabled;
        audit(
          actor(),
          body.enabled ? "knowledge_article.enabled" : "knowledge_article.disabled",
          { type: "knowledge_article", id: a.id },
          { title: a.title },
        );
        return HttpResponse.json(a);
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/saved-replies"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, savedReplyBody);
        if (body instanceof Response) return body;
        const o = org();
        let src = o.knowledgeSources.find((s) => s.kind === "manual");
        if (!src) {
          src = {
            id: crypto.randomUUID(),
            connectionId: null,
            kind: "manual",
            name: "Saved replies",
            status: "idle",
            lastSyncAt: null,
            lastError: null,
            createdAt: new Date().toISOString(),
          };
          o.knowledgeSources.push(src);
        }
        const a: KnowledgeArticle = {
          id: crypto.randomUUID(),
          sourceId: src.id,
          sourceKind: "manual",
          sourceName: src.name,
          externalId: null,
          title: body.title,
          url: body.url,
          bodyText: body.bodyText,
          locale: null,
          enabled: true,
          updatedAt: new Date().toISOString(),
        };
        o.knowledgeArticles.push(a);
        audit(actor(), "saved_reply.created", { type: "knowledge_article", id: a.id }, { title: a.title });
        return HttpResponse.json(a, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.patch(
    url("/saved-replies/:id"),
    guarded(
      async ({ request, params }) => {
        const body = await parse(request, updateSavedReplyBody);
        if (body instanceof Response) return body;
        const a = org().knowledgeArticles.find((x) => x.id === params.id && x.sourceKind === "manual");
        if (!a) return fail(404, "not_found", "Saved reply not found.");
        Object.assign(a, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), {
          updatedAt: new Date().toISOString(),
        });
        audit(actor(), "saved_reply.updated", { type: "knowledge_article", id: a.id }, { title: a.title });
        return HttpResponse.json(a);
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/saved-replies/:id"),
    guarded(
      ({ params }) => {
        const o = org();
        const a = o.knowledgeArticles.find((x) => x.id === params.id && x.sourceKind === "manual");
        if (!a) return fail(404, "not_found", "Saved reply not found.");
        o.knowledgeArticles = o.knowledgeArticles.filter((x) => x.id !== a.id);
        audit(actor(), "saved_reply.deleted", { type: "knowledge_article", id: a.id }, { title: a.title });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),

  // ------------------------------------------------ autonomy & notifications
  http.get(
    url("/autonomy-rules"),
    guarded(() => HttpResponse.json(org().autonomy)),
  ),
  http.post(
    url("/autonomy-rules"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, autonomyRuleBody);
        if (body instanceof Response) return body;
        const o = org();
        if (o.autonomy.some((r) => r.customerAccountId === body.customerAccountId && r.priority === body.priority))
          return fail(409, "duplicate_scope", "A rule for this customer and priority already exists.");
        const rule: AutonomyRule = { id: crypto.randomUUID(), ...body };
        o.autonomy.push(rule);
        audit(actor(), "autonomy.created", { type: "autonomy_rule", id: rule.id }, body);
        return HttpResponse.json(rule, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.put(
    url("/autonomy-rules/:id"),
    guarded(
      async ({ request, params }) => {
        const body = await parse(request, autonomyRuleBody);
        if (body instanceof Response) return body;
        const rule = org().autonomy.find((r) => r.id === params.id);
        if (!rule) return fail(404, "not_found", "Rule not found.");
        Object.assign(rule, body);
        audit(actor(), "autonomy.updated", { type: "autonomy_rule", id: rule.id }, body);
        return HttpResponse.json(rule);
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/autonomy-rules/:id"),
    guarded(
      ({ params }) => {
        const o = org();
        const rule = o.autonomy.find((r) => r.id === params.id);
        if (rule && rule.customerAccountId === null && rule.priority === null)
          return fail(409, "default_rule", "The default rule can be changed but not deleted.");
        o.autonomy = o.autonomy.filter((r) => r.id !== params.id);
        audit(actor(), "autonomy.deleted", { type: "autonomy_rule", id: String(params.id) });
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),
  http.get(
    url("/notification-channels"),
    guarded(() => HttpResponse.json(org().channels)),
  ),
  http.post(
    url("/notification-channels"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, notificationChannelBody);
        if (body instanceof Response) return body;
        const ch: NotificationChannel = { id: crypto.randomUUID(), ...body };
        org().channels.push(ch);
        audit(actor(), "notification_channel.created", { type: "notification_channel", id: ch.id }, { kind: ch.kind });
        return HttpResponse.json(ch, { status: 201 });
      },
      { admin: true },
    ),
  ),
  http.patch(
    url("/notification-channels/:id"),
    guarded(
      async ({ request, params }) => {
        const body = await parse(request, notificationChannelBody.partial());
        if (body instanceof Response) return body;
        const ch = org().channels.find((c) => c.id === params.id);
        if (!ch) return fail(404, "not_found", "Channel not found.");
        Object.assign(ch, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
        return HttpResponse.json(ch);
      },
      { admin: true },
    ),
  ),
  http.delete(
    url("/notification-channels/:id"),
    guarded(
      ({ params }) => {
        const o = org();
        o.channels = o.channels.filter((c) => c.id !== params.id);
        return new HttpResponse(null, { status: 204 });
      },
      { admin: true },
    ),
  ),

  // ------------------------------------------------ dashboard, replay, usage, audit
  http.get(
    url("/dashboard"),
    guarded(() => HttpResponse.json(dashboard(Date.now()))),
  ),
  // Onboarding (the checklist is derived from the mock org's state, like the API).
  http.get(
    url("/onboarding"),
    guarded(() => HttpResponse.json(onboardingState())),
  ),
  http.patch(
    url("/onboarding"),
    guarded(async ({ request }) => {
      const body = await parse(request, updateOnboardingBody);
      if (body instanceof Response) return body;
      const o = org();
      const userId = getDb().me.user.id;
      o.onboarding ??= {};
      const cur = o.onboarding[userId] ?? { checklistDismissed: false, welcomeSeen: true };
      if (body.checklistDismissed !== undefined) cur.checklistDismissed = body.checklistDismissed;
      if (body.welcomeSeen) cur.welcomeSeen = true;
      o.onboarding[userId] = cur;
      return HttpResponse.json(onboardingState());
    }),
  ),
  http.get(
    url("/replays"),
    guarded(() => {
      advanceReplays(Date.now());
      return HttpResponse.json(list([...org().replays].sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
    }),
  ),
  http.get(
    url("/replays/:id"),
    guarded(({ params }) => {
      advanceReplays(Date.now());
      const r = org().replays.find((x) => x.id === params.id);
      return r ? HttpResponse.json(r) : fail(404, "not_found", "Replay not found.");
    }),
  ),
  http.post(
    url("/replays"),
    guarded(async ({ request }) => {
      const body = await parse(request, createReplayBody);
      if (body instanceof Response) return body;
      const o = org();
      const conn = o.connections.find((c) => c.id === body.connectionId);
      if (!conn) return fail(404, "not_found", "Connect a help desk first.");
      const replay: Replay = {
        id: `rp_${crypto.randomUUID().slice(0, 8)}`,
        connectionId: body.connectionId,
        days: body.days,
        status: "queued",
        progress: { ticketsScanned: 0, ticketsTotal: Math.max(conn.ticketCount, 3_906) },
        result: null,
        createdAt: new Date().toISOString(),
      };
      o.replays.unshift(replay);
      audit(actor(), "replay.started", { type: "replay", id: replay.id }, { days: body.days });
      return HttpResponse.json(replay, { status: 201 });
    }),
  ),
  http.get(
    url("/usage"),
    guarded(() => HttpResponse.json(usage(Date.now()))),
  ),

  // ------------------------------------------------ billing (T-65)
  http.get(
    url("/billing"),
    guarded(() => HttpResponse.json(billing(Date.now()))),
  ),
  http.post(
    url("/billing/checkout"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, billingCheckoutBody);
        if (body instanceof Response) return body;
        subscribe(body.plan);
        audit(actor(), "billing.checkout_completed", { type: "organization", id: org().settings.id }, body);
        return HttpResponse.json({ url: "/billing?checkout=success" });
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/billing/credit-packs/checkout"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, creditPackCheckoutBody);
        if (body instanceof Response) return body;
        const pack = CREDIT_PACKS.find((p) => p.id === body.pack);
        if (!pack) return fail(400, "validation_failed", "Unknown credit pack.");
        const o = org();
        o.billing.purchasedCredits += pack.credits;
        o.billing.hasCustomer = true;
        audit(actor(), "billing.credits_purchased", { type: "organization", id: o.settings.id }, body);
        return HttpResponse.json({ url: "/billing?credits=success" });
      },
      { admin: true },
    ),
  ),
  http.post(
    url("/billing/portal"),
    guarded(
      () => {
        if (!org().billing.hasCustomer) return fail(409, "no_customer", "Choose a plan first.");
        return HttpResponse.json({ url: "/billing?portal=return" });
      },
      { admin: true },
    ),
  ),
  // The mock accepts this in any mode so the demo can show every billing state.
  http.post(
    url("/billing/manual"),
    guarded(
      async ({ request }) => {
        const body = await parse(request, manualBillingBody);
        if (body instanceof Response) return body;
        const b = org().billing;
        if (body.plan) setPlan(body.plan);
        if (body.status) {
          b.status = body.status;
          b.pastDueSince = body.status === "past_due" ? (b.pastDueSince ?? new Date().toISOString()) : null;
          if (body.status !== "trialing") {
            b.hasCustomer = true;
            b.hasSubscription = body.status !== "canceled";
            if (b.invoices.length === 0) b.invoices = buildInvoices(Date.now(), PLANS[b.plan].priceCents ?? 0);
          }
        }
        if (body.trialEndsAt !== undefined) b.trialEndsAt = body.trialEndsAt;
        if (body.pastDueSince !== undefined) b.pastDueSince = body.pastDueSince;
        if (body.grantCredits) b.purchasedCredits += body.grantCredits;
        audit(actor(), "billing.manual_update", { type: "organization", id: org().settings.id }, body);
        return HttpResponse.json(billing(Date.now()));
      },
      { admin: true },
    ),
  ),
  http.get(
    url("/audit-events"),
    guarded(({ request }) => {
      if (!isAdmin()) return fail(403, "forbidden", "Only admins can view the audit log.");
      const offset = Number(new URL(request.url).searchParams.get("cursor") ?? 0) || 0;
      const all = org().audit;
      const page = all.slice(offset, offset + 40);
      return HttpResponse.json(list(page, offset + 40 < all.length ? String(offset + 40) : null));
    }),
  ),
];
