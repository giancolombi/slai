/**
 * Demo data: org "Acme Cloud", owner demo@slai.dev, a `demo` help-desk
 * connection, two customer accounts, an active default Enterprise policy and an
 * active Premium policy. Idempotent: rerunning updates rows in place.
 */
import { randomBytes } from "node:crypto";
import { type PolicyInput, parsePolicy } from "@slai/sla-engine";
import { and, eq, sql } from "drizzle-orm";
import { connect, type Tx } from "./client.js";
import { encrypt, encryptJson, type Keyring } from "./crypto.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { connections, customerAccounts, memberships, organizations, slaPolicies, users } from "./schema.js";

export const DEMO = {
  orgName: "Acme Cloud",
  orgSlug: "acme-cloud",
  email: "demo@slai.dev",
  password: "slai-demo-password-1",
  name: "Demo Owner",
} as const;

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

export async function seed(ownerUrl: string, opts: { keyring?: Keyring } = {}) {
  const { db, close } = connect(ownerUrl, { max: 1, applicationName: "slai-seed" });
  try {
    return await db.transaction(async (tx) => {
      // Session-scoped org setting is not needed: the owner role bypasses RLS for seeding.
      const [org] = await tx
        .insert(organizations)
        .values({ name: DEMO.orgName, slug: DEMO.orgSlug, plan: "growth", monthlySpendCapCents: 50_000 })
        .onConflictDoUpdate({ target: organizations.slug, set: { name: DEMO.orgName } })
        .returning();
      const orgId = org!.id;

      const [prior] = await tx.select().from(users).where(eq(users.email, DEMO.email));
      const passwordHash =
        prior && (await verifyPassword(prior.passwordHash, DEMO.password))
          ? prior.passwordHash
          : await hashPassword(DEMO.password);
      const [user] = await tx
        .insert(users)
        .values({ email: DEMO.email, name: DEMO.name, passwordHash })
        .onConflictDoUpdate({ target: users.email, set: { passwordHash, disabledAt: null } })
        .returning();
      const userId = user!.id;
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
          credentials: encryptJson({}, { keyring: opts.keyring, aad: `connection:${connectionId}` }),
          webhookSecret: encrypt(randomBytes(32).toString("base64url"), {
            keyring: opts.keyring,
            aad: `connection:${connectionId}:webhook`,
          }),
          config: { ticketsPerDay: 40 },
          createdBy: userId,
        });
      }

      const customers = [
        { name: "Globex Corporation", domains: ["globex.com"], fee: 1_250_000, policyId: premiumId },
        { name: "Initech", domains: ["initech.io"], fee: 480_000, policyId: null },
      ];
      for (const c of customers) {
        await tx
          .insert(customerAccounts)
          .values({ orgId, name: c.name, domains: c.domains, monthlyFeeCents: c.fee, policyId: c.policyId })
          .onConflictDoUpdate({
            target: [customerAccounts.orgId, customerAccounts.name],
            set: { domains: c.domains, monthlyFeeCents: c.fee, policyId: c.policyId, updatedAt: sql`now()` },
          });
      }
      return { orgId, userId, connectionId, policyIds: { enterprise: enterpriseId, premium: premiumId } };
    });
  } finally {
    await close();
  }
}
