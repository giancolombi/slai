import {
  autonomyRules,
  connections,
  contracts,
  customerAccounts,
  invitations,
  memberships,
  notificationChannels,
  onboardingState,
  replays,
  slaPolicies,
  type Tx,
} from "@slai/db";
import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepId,
  OPTIONAL_ONBOARDING_STEPS,
  updateOnboardingBody,
} from "@slai/shared";
import { and, eq, gt, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auth } from "../context.js";
import { body } from "../validate.js";

/** True when `table` has at least one row matching `where` (RLS scopes it to the org). */
async function exists(tx: Tx, table: PgTable, where?: SQL): Promise<boolean> {
  const rows = await tx.select({ one: sql<number>`1` }).from(table).where(where).limit(1);
  return rows.length > 0;
}

/**
 * Derives each checklist step from the org's real state (see `ONBOARDING_STEPS`
 * in @slai/shared for the rules). Pure reads inside `withOrg`.
 */
export async function deriveSteps(tx: Tx, now: Date): Promise<Record<OnboardingStepId, boolean>> {
  const activeDefault = and(eq(slaPolicies.status, "active"), eq(slaPolicies.isDefault, true));
  const [connect, contract, policy, hasDefault, assigned, autonomy, alerts, invited, teammates, replay] =
    await Promise.all([
      exists(tx, connections, eq(connections.status, "active")),
      exists(tx, contracts, isNull(contracts.archivedAt)),
      exists(
        tx,
        slaPolicies,
        and(eq(slaPolicies.status, "active"), or(isNotNull(slaPolicies.contractId), eq(slaPolicies.isDefault, true))),
      ),
      exists(tx, slaPolicies, activeDefault),
      exists(tx, customerAccounts, isNotNull(customerAccounts.policyId)),
      exists(tx, autonomyRules),
      exists(tx, notificationChannels, eq(notificationChannels.enabled, true)),
      exists(
        tx,
        invitations,
        and(isNull(invitations.revokedAt), or(isNotNull(invitations.acceptedAt), gt(invitations.expiresAt, now))),
      ),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(memberships)
        .where(isNull(memberships.disabledAt))
        .then((r) => (r[0]?.n ?? 0) > 1),
      exists(tx, replays, ne(replays.status, "failed")),
    ]);
  return {
    connect,
    contract,
    policy,
    assign: assigned || hasDefault,
    autonomy,
    alerts,
    invite: invited || teammates,
    replay,
  };
}

export function onboardingRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const load = (orgId: string, userId: string) =>
    deps.orgDb.withOrg(orgId, async (tx): Promise<OnboardingState> => {
      const done = await deriveSteps(tx, deps.now());
      const [prefs] = await tx
        .select()
        .from(onboardingState)
        .where(and(eq(onboardingState.orgId, orgId), eq(onboardingState.userId, userId)));
      const steps = ONBOARDING_STEPS.map((id) => ({
        id,
        done: done[id],
        optional: OPTIONAL_ONBOARDING_STEPS.includes(id),
      }));
      const required = steps.filter((s) => !s.optional);
      return {
        steps,
        requiredDone: required.filter((s) => s.done).length,
        requiredTotal: required.length,
        allDone: steps.every((s) => s.done),
        checklistDismissed: Boolean(prefs?.checklistDismissedAt),
        welcomeSeen: Boolean(prefs?.welcomeSeenAt),
      };
    });

  app.get("/onboarding", async (c) => {
    const a = auth(c);
    return c.json(await load(a.orgId, a.user.id));
  });

  /** The user's own preferences in the active org. Not security-relevant, so not audited. */
  app.patch("/onboarding", async (c) => {
    const a = auth(c);
    const input = await body(c, updateOnboardingBody);
    const now = deps.now();
    const set: Partial<typeof onboardingState.$inferInsert> = {};
    if (input.checklistDismissed !== undefined) set.checklistDismissedAt = input.checklistDismissed ? now : null;
    if (input.welcomeSeen) set.welcomeSeenAt = now;
    await deps.orgDb.withOrg(a.orgId, (tx) =>
      tx
        .insert(onboardingState)
        .values({ orgId: a.orgId, userId: a.user.id, ...set })
        .onConflictDoUpdate({ target: [onboardingState.orgId, onboardingState.userId], set }),
    );
    return c.json(await load(a.orgId, a.user.id));
  });

  return app;
}
