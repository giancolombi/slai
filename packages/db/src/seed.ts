/**
 * Demo data: org "Acme Cloud", owner demo@slai.dev (pre-enrolled in TOTP with a
 * fixed, dev-only secret), a `demo` help-desk connection, customer accounts, an
 * active default Enterprise policy and an active Premium policy. Idempotent:
 * rerunning updates rows in place.
 */
import { randomBytes } from "node:crypto";
import { type PolicyInput, parsePolicy } from "@slai/sla-engine";
import { and, eq, sql } from "drizzle-orm";
import { type AuthSecret, authSecrets, sealForAuth } from "./auth-secrets.js";
import { connect, type Tx } from "./client.js";
import { AAD, encrypt, encryptJson, type Keyring } from "./crypto.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import {
  accounts,
  autonomyRules,
  connections,
  customerAccounts,
  memberships,
  notificationChannels,
  organizations,
  slaPolicies,
  twoFactors,
  users,
} from "./schema.js";
import { base32Encode, otpauthUrl } from "./totp.js";

export const DEMO = {
  orgName: "Acme Cloud",
  orgSlug: "acme-cloud",
  email: "demo@slai.dev",
  password: "slai-demo-password-1",
  name: "Demo Owner",
  /**
   * DEV ONLY. The raw TOTP secret better-auth stores for the demo user (sealed).
   * Authenticator apps and `pnpm demo:otp` use its base32 form.
   */
  totpSecret: "slai-demo-totp-secret-dev-only-1",
  /** DEV ONLY. Ten single-use backup codes for the demo user. */
  backupCodes: Array.from({ length: 10 }, (_, i) => `demo${i}-backup`),
} as const;

/** The demo user's TOTP secret in base32 (what an authenticator app is given). */
export const DEMO_TOTP_BASE32 = base32Encode(Buffer.from(DEMO.totpSecret, "utf8"));
export const DEMO_OTPAUTH_URL = otpauthUrl(DEMO_TOTP_BASE32, DEMO.email);

const US_HOLIDAYS = [
  "2026-01-01",
  "2026-05-25",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-05-31",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
];
const weekdays = (start: string, end: string) =>
  Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [{ start, end }]]));
const h = (hours: number) => hours * 60;

/** A typical enterprise support schedule (business hours, US Eastern). */
export const ENTERPRISE_POLICY: Omit<PolicyInput, "id"> = {
  name: "Enterprise Support SLA",
  calendar: { timezone: "America/New_York", weekly: weekdays("08:00", "18:00"), holidays: US_HOLIDAYS },
  defaultPriority: "normal",
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 60, clock: "calendar" },
    { metric: "first_response", priority: "high", minutes: h(4), clock: "business" },
    { metric: "first_response", priority: "normal", minutes: h(8), clock: "business" },
    { metric: "first_response", priority: "low", minutes: h(16), clock: "business" },
    { metric: "next_response", priority: "urgent", minutes: h(2), clock: "calendar" },
    { metric: "next_response", priority: "high", minutes: h(8), clock: "business" },
    { metric: "next_response", priority: "normal", minutes: h(16), clock: "business" },
    { metric: "periodic_update", priority: "urgent", minutes: h(4), clock: "calendar" },
    { metric: "resolution", priority: "urgent", minutes: h(24), clock: "calendar" },
    { metric: "resolution", priority: "high", minutes: h(30), clock: "business" },
    { metric: "resolution", priority: "normal", minutes: h(50), clock: "business" },
    { metric: "resolution", priority: "low", minutes: h(100), clock: "business" },
  ],
  pauseStatuses: { resolution: ["pending", "on_hold"], next_response: ["pending"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [
    {
      id: "urgent-first-response",
      basis: "per_breach",
      metric: "first_response",
      priority: "urgent",
      amount: { kind: "percent_of_fee", percent: 5 },
      capPercent: 20,
      sourceClause: "§7.2: 5% of the monthly fee for each Severity 1 initial response outside the target.",
    },
    {
      id: "monthly-attainment",
      basis: "attainment",
      metric: null,
      priority: null,
      tiers: [
        { belowPercent: 95, amount: { kind: "percent_of_fee", percent: 10 } },
        { belowPercent: 90, amount: { kind: "percent_of_fee", percent: 25 } },
      ],
      capPercent: 30,
      sourceClause: "§7.3: below 95% monthly attainment, 10% credit; below 90%, 25%; capped at 30%.",
    },
  ],
};

/** A 24x7 premium schedule with tighter targets. */
export const PREMIUM_POLICY: Omit<PolicyInput, "id"> = {
  name: "Premium 24x7 SLA",
  calendar: {
    timezone: "UTC",
    weekly: Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "00:00", end: "24:00" }]]),
    ),
    holidays: [],
  },
  defaultPriority: "normal",
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 15, clock: "calendar" },
    { metric: "first_response", priority: "high", minutes: 60, clock: "calendar" },
    { metric: "first_response", priority: "normal", minutes: h(4), clock: "calendar" },
    { metric: "first_response", priority: "low", minutes: h(8), clock: "calendar" },
    { metric: "next_response", priority: "urgent", minutes: 60, clock: "calendar" },
    { metric: "next_response", priority: "high", minutes: h(4), clock: "calendar" },
    { metric: "periodic_update", priority: "urgent", minutes: h(1), clock: "calendar" },
    { metric: "periodic_update", priority: "high", minutes: h(4), clock: "calendar" },
    { metric: "resolution", priority: "urgent", minutes: h(8), clock: "calendar" },
    { metric: "resolution", priority: "high", minutes: h(24), clock: "calendar" },
    { metric: "resolution", priority: "normal", minutes: h(72), clock: "calendar" },
  ],
  pauseStatuses: { resolution: ["pending"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [
    {
      id: "per-breach",
      basis: "per_breach",
      metric: null,
      priority: null,
      amount: { kind: "fixed_cents", cents: 50_000 },
      capPercent: 50,
      sourceClause: "Schedule B §2: $500 per missed target, up to 50% of the monthly fee.",
    },
  ],
};

async function upsertPolicy(tx: Tx, orgId: string, def: Omit<PolicyInput, "id">, isDefault: boolean, userId: string) {
  const [existing] = await tx
    .select()
    .from(slaPolicies)
    .where(and(eq(slaPolicies.orgId, orgId), eq(slaPolicies.name, def.name), eq(slaPolicies.status, "active")));
  const id = existing?.id ?? crypto.randomUUID();
  const definition = parsePolicy({ ...def, id });
  if (existing) {
    await tx.update(slaPolicies).set({ definition, isDefault }).where(eq(slaPolicies.id, id));
  } else {
    await tx.insert(slaPolicies).values({
      id,
      orgId,
      lineageId: id,
      name: def.name,
      version: 1,
      status: "active",
      definition,
      isDefault,
      approvedBy: userId,
      approvedAt: new Date(),
      createdBy: userId,
    });
  }
  return id;
}

/** The demo org runs Scale in manual billing mode (no Stripe), so autopilot works locally (T-65). */
const DEMO_BILLING = { plan: "scale", billingStatus: "active" as const, trialEndsAt: null };

export async function seed(ownerUrl: string, opts: { keyring?: Keyring; authSecrets?: AuthSecret[] } = {}) {
  const secrets = opts.authSecrets ?? authSecretsFromEnv();
  const { db, close } = connect(ownerUrl, { max: 1, applicationName: "slai-seed" });
  try {
    return await db.transaction(async (tx) => {
      // Session-scoped org setting is not needed: the owner role bypasses RLS for seeding.
      const [org] = await tx
        .insert(organizations)
        .values({ name: DEMO.orgName, slug: DEMO.orgSlug, monthlySpendCapCents: 50_000, ...DEMO_BILLING })
        .onConflictDoUpdate({ target: organizations.slug, set: { name: DEMO.orgName, ...DEMO_BILLING } })
        .returning();
      const orgId = org!.id;

      const [user] = await tx
        .insert(users)
        .values({ email: DEMO.email, name: DEMO.name, emailVerified: true, mfaEnabled: true })
        .onConflictDoUpdate({ target: users.email, set: { disabledAt: null, mfaEnabled: true } })
        .returning();
      const userId = user!.id;
      const [prior] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
      const password =
        prior?.password && (await verifyPassword(prior.password, DEMO.password))
          ? prior.password
          : await hashPassword(DEMO.password);
      await tx
        .insert(accounts)
        .values({ userId, accountId: userId, providerId: "credential", password })
        .onConflictDoUpdate({ target: [accounts.providerId, accounts.accountId], set: { password } });
      // Pre-enrolled TOTP (sealed the way better-auth's twoFactor plugin seals it).
      const totp = {
        secret: await sealForAuth(DEMO.totpSecret, secrets),
        backupCodes: await sealForAuth(JSON.stringify(DEMO.backupCodes), secrets),
        verified: true,
        failedVerificationCount: 0,
        lockedUntil: null,
      };
      await tx
        .insert(twoFactors)
        .values({ userId, ...totp })
        .onConflictDoUpdate({ target: twoFactors.userId, set: totp });
      await tx
        .insert(memberships)
        .values({ orgId, userId, role: "owner" })
        .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: "owner" } });

      const enterpriseId = await upsertPolicy(tx, orgId, ENTERPRISE_POLICY, true, userId);
      const premiumId = await upsertPolicy(tx, orgId, PREMIUM_POLICY, false, userId);

      const [conn] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.orgId, orgId), eq(connections.provider, "demo")));
      let connectionId = conn?.id;
      if (!connectionId) {
        connectionId = crypto.randomUUID();
        await tx.insert(connections).values({
          id: connectionId,
          orgId,
          provider: "demo",
          name: "Demo Help Desk",
          credentials: encryptJson({}, { keyring: opts.keyring, aad: AAD.connectionCredentials(connectionId) }),
          webhookSecret: encrypt(randomBytes(32).toString("base64url"), {
            keyring: opts.keyring,
            aad: AAD.connectionWebhookSecret(connectionId),
          }),
          config: { ticketsPerDay: 40 },
          createdBy: userId,
        });
      }

      // Customers match the demo help desk's requester orgs (packages/connectors demo content).
      const customers = [
        {
          name: "Northwind Analytics",
          domains: ["northwind-analytics.example"],
          ext: ["org-northwind"],
          fee: 1_250_000,
          policyId: premiumId,
        },
        {
          name: "Meridian Payments",
          domains: ["meridianpay.example"],
          ext: ["org-meridian"],
          fee: 980_000,
          policyId: premiumId,
        },
        {
          name: "Bluepeak Logistics",
          domains: ["bluepeak.example"],
          ext: ["org-bluepeak"],
          fee: 640_000,
          policyId: null,
        },
        {
          name: "Quillon Health",
          domains: ["quillon-health.example"],
          ext: ["org-quillon"],
          fee: 720_000,
          policyId: null,
        },
        {
          name: "Cobalt Insurance",
          domains: ["cobalt-ins.example"],
          ext: ["org-cobalt"],
          fee: 560_000,
          policyId: null,
        },
        {
          name: "Lumen Retail Group",
          domains: ["lumenretail.example"],
          ext: ["org-lumen"],
          fee: 410_000,
          policyId: null,
        },
      ];
      const customerIds: Record<string, string> = {};
      for (const c of customers) {
        const [row] = await tx
          .insert(customerAccounts)
          .values({
            orgId,
            name: c.name,
            domains: c.domains,
            externalOrgIds: c.ext,
            monthlyFeeCents: c.fee,
            policyId: c.policyId,
          })
          .onConflictDoUpdate({
            target: [customerAccounts.orgId, customerAccounts.name],
            set: {
              domains: c.domains,
              externalOrgIds: c.ext,
              monthlyFeeCents: c.fee,
              policyId: c.policyId,
              updatedAt: sql`now()`,
            },
          })
          .returning({ id: customerAccounts.id });
        customerIds[c.name] = row!.id;
      }

      // Autonomy: assist by default, autopilot for one premium customer, earlier drafts for urgent tickets.
      const rules = [
        { customerAccountId: null, priority: null, level: "assist" as const, triggerAt: "at_risk" as const },
        {
          customerAccountId: null,
          priority: "urgent" as const,
          level: "assist" as const,
          triggerAt: "warning" as const,
        },
        {
          customerAccountId: customerIds["Northwind Analytics"]!,
          priority: null,
          level: "autopilot" as const,
          triggerAt: "at_risk" as const,
        },
      ];
      for (const r of rules) {
        await tx
          .insert(autonomyRules)
          .values({ orgId, ...r, minConfidence: 0.8 })
          .onConflictDoUpdate({
            target: [autonomyRules.orgId, autonomyRules.customerAccountId, autonomyRules.priority],
            set: { level: r.level, triggerAt: r.triggerAt },
          });
      }

      const [channel] = await tx
        .select()
        .from(notificationChannels)
        .where(and(eq(notificationChannels.orgId, orgId), eq(notificationChannels.kind, "email")));
      if (!channel) {
        await tx
          .insert(notificationChannels)
          .values({ orgId, kind: "email", target: "support-leads@acme-cloud.example", minRisk: "at_risk" });
      }
      return { orgId, userId, connectionId, policyIds: { enterprise: enterpriseId, premium: premiumId } };
    });
  } finally {
    await close();
  }
}

/** better-auth's secrets from SESSION_SECRET (and SESSION_SECRETS_PREVIOUS). */
export function authSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthSecret[] {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set (run `pnpm setup:env`)");
  return authSecrets(env.SESSION_SECRET, {
    version: env.SESSION_SECRET_VERSION ? Number(env.SESSION_SECRET_VERSION) : undefined,
    previous: env.SESSION_SECRETS_PREVIOUS,
  });
}
