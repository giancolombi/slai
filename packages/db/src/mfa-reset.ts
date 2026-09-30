/**
 * Second-factor recovery (T-19). Used by the admin reset (apps/api, as
 * `slai_auth`) and by the break-glass CLI (as the database owner).
 *
 * A reset removes every second factor (TOTP secret, backup codes, passkeys) and
 * every session of the user. With no factor left, the next sign-in lands in
 * mandatory enrollment (`mfaState` → `enrollment_required`).
 */
import { hostname, userInfo } from "node:os";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { audit } from "./audit.js";
import { connect, type Executor } from "./client.js";
import { createJobSender, createProducerBoss } from "./jobs.js";
import { memberships, passkeys, sessions, twoFactors, users } from "./schema.js";

export interface FactorsRemoved {
  totp: boolean;
  passkeys: number;
  sessions: number;
}

/** Removes the user's TOTP, backup codes and passkeys and revokes all their sessions. Run it in a transaction. */
export async function resetSecondFactors(tx: Executor, userId: string): Promise<FactorsRemoved> {
  const tf = await tx.delete(twoFactors).where(eq(twoFactors.userId, userId)).returning({ id: twoFactors.id });
  const pk = await tx.delete(passkeys).where(eq(passkeys.userId, userId)).returning({ id: passkeys.id });
  const ss = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  await tx.update(users).set({ mfaEnabled: false }).where(eq(users.id, userId));
  return { totp: tf.length > 0, passkeys: pk.length, sessions: ss.length };
}

const RUNTIME_ROLES = new Set(["slai_app", "slai_worker", "slai_auth"]);

export interface BreakGlassInput {
  email: string;
  /** Why (a ticket id and how the user's identity was verified). Recorded in the audit trail. */
  reason: string;
  /** Who runs it; defaults to the OS user. */
  operator?: string;
}

export interface BreakGlassResult extends FactorsRemoved {
  userId: string;
  orgIds: string[];
}

/**
 * The break-glass reset (`pnpm auth:break-glass <email> --reason "..."`): the only
 * way to reset the factors of an organization's last owner. It needs the database
 * owner's credentials (the runtime roles are refused), resets the user's factors,
 * writes `auth.mfa_break_glass_reset` into every org the user belongs to, and
 * queues the security email.
 */
export async function breakGlassReset(ownerUrl: string, input: BreakGlassInput): Promise<BreakGlassResult> {
  const reason = input.reason.trim();
  if (reason.length < 10)
    throw new Error("--reason is required (at least 10 characters: a ticket id and how identity was verified)");
  const probe = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const [who] = await probe<{ user: string; owns: boolean }[]>`
      select current_user as "user",
        (select rolsuper from pg_roles where rolname = current_user)
          or exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'users' and tableowner = current_user)
        as owns`;
    if (!who || RUNTIME_ROLES.has(who.user) || !who.owns) {
      throw new Error(`break-glass needs the database owner's credentials (connected as ${who?.user ?? "unknown"})`);
    }
  } finally {
    await probe.end({ timeout: 5 });
  }

  const operator = (input.operator ?? userInfo().username).slice(0, 100);
  const db = connect(ownerUrl, { max: 1, applicationName: "slai-break-glass" });
  try {
    const result = await db.db.transaction(async (tx) => {
      const [u] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, input.email.trim()));
      if (!u) throw new Error(`no user with email ${input.email}`);
      const orgs = await tx
        .select({ orgId: memberships.orgId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, u.id));
      const removed = await resetSecondFactors(tx, u.id);
      const entry = {
        actor: { type: "system" as const, id: null, name: `break-glass:${operator}` },
        action: "auth.mfa_break_glass_reset",
        target: { type: "user", id: u.id },
        metadata: { reason, operator, host: hostname(), email: u.email, removed, roles: orgs },
      };
      if (orgs.length === 0) await audit(tx, { ...entry, orgId: null });
      for (const o of orgs) await audit(tx, { ...entry, orgId: o.orgId });
      return { userId: u.id, orgIds: orgs.map((o) => o.orgId), ...removed };
    });
    const first = result.orgIds[0];
    if (first) {
      const boss = createProducerBoss(ownerUrl);
      boss.on("error", () => {});
      await boss.start();
      try {
        await createJobSender(boss).send(db.db, "send-security-email", {
          orgId: first,
          userId: result.userId,
          kind: "mfa_reset",
          actorUserId: null,
        });
      } finally {
        await boss.stop({ graceful: false });
      }
    }
    return result;
  } finally {
    await db.close();
  }
}
