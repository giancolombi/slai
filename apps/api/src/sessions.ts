import { createHash, randomBytes } from "node:crypto";
import { type Executor, memberships, organizations, sessions, users } from "@slai/db";
import type { Role } from "@slai/shared";
import { and, asc, eq } from "drizzle-orm";
import type { AuthContext } from "./context.js";

export const SESSION_COOKIE = "slai_session";
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often per session. */
const TOUCH_EVERY_MS = 60 * 1000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a session and returns the cookie token (only its sha256 is stored). */
export async function createSession(
  db: Executor,
  s: { userId: string; orgId: string; mfaVerified: boolean; ip: string | null; userAgent: string | null; now: Date },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId: s.userId,
    activeOrgId: s.orgId,
    mfaVerified: s.mfaVerified,
    ip: s.ip,
    userAgent: s.userAgent?.slice(0, 500) ?? null,
    createdAt: s.now,
    lastSeenAt: s.now,
    expiresAt: new Date(s.now.getTime() + ABSOLUTE_TIMEOUT_MS),
  });
  return token;
}

/** Resolves a cookie token to its session, user, active org and role (systemDb). */
export async function resolveSession(db: Executor, token: string, now: Date): Promise<AuthContext | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)));
  if (!row) return null;
  const { s, u } = row;
  const t = now.getTime();
  if (u.disabledAt || s.expiresAt.getTime() <= t || s.lastSeenAt.getTime() + IDLE_TIMEOUT_MS <= t) {
    await db.delete(sessions).where(eq(sessions.id, s.id));
    return null;
  }

  // The active org must still be one the user belongs to; otherwise fall back to another.
  let membership = s.activeOrgId
    ? (
        await db
          .select({ orgId: memberships.orgId, role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.userId, u.id), eq(memberships.orgId, s.activeOrgId)))
      )[0]
    : undefined;
  if (!membership) {
    [membership] = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, u.id))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (!membership) return null;
    await db.update(sessions).set({ activeOrgId: membership.orgId }).where(eq(sessions.id, s.id));
  }
  const [org] = await db
    .select({ requireMfa: organizations.requireMfa })
    .from(organizations)
    .where(eq(organizations.id, membership.orgId));

  if (t - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, s.id));
  }
  return {
    sessionId: s.id,
    user: { id: u.id, email: u.email, name: u.name, mfaEnabled: u.mfaEnabled },
    orgId: membership.orgId,
    role: membership.role as Role,
    mfaVerified: s.mfaVerified,
    orgRequiresMfa: org?.requireMfa ?? false,
  };
}
