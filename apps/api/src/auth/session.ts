/**
 * Turns a better-auth session into our AuthContext: the active org and role
 * (rechecked against memberships on every request), the 7-day absolute limit,
 * disabled users, and the MFA state that the gate enforces (TR-23).
 */
import { accounts, memberships, organizations, passkeys, sessions, users } from "@slai/db";
import type { AuthMethod, MfaState, Role } from "@slai/shared";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { AppDeps, AuthContext } from "../context.js";
import { ABSOLUTE_TIMEOUT_MS, type Auth } from "./better-auth.js";

export interface SessionFacts {
  authMethod: AuthMethod;
  mfaVerified: boolean;
  ssoOrgId: string | null;
  activeOrgId: string;
  factors: { totp: boolean; passkeys: number };
  ssoRequireMfa: boolean;
}

/**
 * The MFA rule (pure, so it is unit-tested directly):
 * - a passkey sign-in (with user verification) is MFA;
 * - an SSO session in the org whose IdP authenticated it is trusted, unless
 *   that org requires slai MFA for SSO users;
 * - everything else needs a second factor verified in this session: without
 *   any factor that means enrollment, with one it means verification.
 */
export function mfaState(f: SessionFacts): MfaState {
  if (f.authMethod === "passkey") return "satisfied";
  if (f.authMethod === "sso" && f.ssoOrgId === f.activeOrgId && !f.ssoRequireMfa) return "satisfied";
  if (f.mfaVerified) return "satisfied";
  return f.factors.totp || f.factors.passkeys > 0 ? "verification_required" : "enrollment_required";
}

type SessionRow = { id: string; userId: string; createdAt: Date } & Record<string, unknown>;
type UserRow = { id: string; email: string; name: string } & Record<string, unknown>;

/** Builds the AuthContext, or null (and revokes the session) when it must not be used. */
export async function toAuthContext(
  deps: Pick<AppDeps, "authDb" | "now">,
  session: SessionRow,
  user: UserRow,
): Promise<AuthContext | null> {
  const db = deps.authDb.db;
  const [u] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, user.id));
  const expired = deps.now().getTime() >= new Date(session.createdAt).getTime() + ABSOLUTE_TIMEOUT_MS;
  if (!u || u.disabledAt || expired) {
    await db.delete(sessions).where(eq(sessions.id, session.id));
    return null;
  }

  // The active org must still be one the user belongs to; otherwise fall back to the oldest.
  const activeOrgId = typeof session.activeOrgId === "string" ? session.activeOrgId : null;
  let membership = activeOrgId
    ? (
        await db
          .select({ orgId: memberships.orgId, role: memberships.role })
          .from(memberships)
          .where(
            and(eq(memberships.userId, user.id), eq(memberships.orgId, activeOrgId), isNull(memberships.disabledAt)),
          )
      )[0]
    : undefined;
  if (!membership) {
    [membership] = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), isNull(memberships.disabledAt)))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (!membership) return null;
    await db.update(sessions).set({ activeOrgId: membership.orgId }).where(eq(sessions.id, session.id));
  }

  const [[org], [pk], [pw]] = await Promise.all([
    db
      .select({ ssoRequireMfa: organizations.ssoRequireMfa })
      .from(organizations)
      .where(eq(organizations.id, membership.orgId)),
    db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, user.id)),
    db
      .select({ n: count() })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))),
  ]);
  const totp = user.twoFactorEnabled === true;
  const authMethod = (
    ["password", "passkey", "sso"].includes(session.authMethod as string) ? session.authMethod : "password"
  ) as AuthMethod;
  const factors = { totp, passkeys: pk?.n ?? 0 };
  return {
    sessionId: session.id,
    user: { id: user.id, email: user.email, name: user.name, mfaEnabled: totp },
    orgId: membership.orgId,
    role: membership.role as Role,
    authMethod,
    mfa: mfaState({
      authMethod,
      mfaVerified: session.mfaVerified === true,
      ssoOrgId: typeof session.ssoOrgId === "string" ? session.ssoOrgId : null,
      activeOrgId: membership.orgId,
      factors,
      ssoRequireMfa: org?.ssoRequireMfa ?? false,
    }),
    factors: { ...factors, hasPassword: (pw?.n ?? 0) > 0 },
    stepUpAt: session.stepUpAt ? new Date(session.stepUpAt as string | Date) : null,
  };
}

/**
 * Resolves the session for request headers through better-auth (which checks
 * the cookie signature and the idle expiry, and slides it). Returns the
 * refreshed Set-Cookie headers to forward.
 */
export async function resolveAuth(
  deps: Pick<AppDeps, "authDb" | "now">,
  auth: Auth,
  headers: Headers,
): Promise<{ ctx: AuthContext | null; setCookies: string[] }> {
  const { headers: out, response } = await auth.api.getSession({ headers, returnHeaders: true });
  const setCookies = out.getSetCookie();
  if (!response) return { ctx: null, setCookies };
  const ctx = await toAuthContext(deps, response.session as unknown as SessionRow, response.user as UserRow);
  return { ctx, setCookies };
}
