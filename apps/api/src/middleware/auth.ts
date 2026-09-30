import { API_BASE, type Role } from "@slai/shared";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { Auth } from "../auth/better-auth.js";
import { SESSION_COOKIE } from "../auth/better-auth.js";
import { resolveAuth } from "../auth/session.js";
import { type AppDeps, type AppEnv, type AuthContext, ROLE_RANK } from "../context.js";
import { ApiError, forbidden, unauthorized } from "../errors.js";

/**
 * Loads the better-auth session (if any) into `c.var.auth`, forwarding the
 * sliding-expiry cookie refresh. An unusable session (absolute limit, disabled
 * user, no organization) is revoked and its cookie cleared.
 */
export function loadSession(deps: Pick<AppDeps, "authDb" | "now" | "env">, auth: Auth): MiddlewareHandler<AppEnv> {
  const cookieName = deps.env.NODE_ENV === "production" ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE;
  return async (c, next) => {
    if (!getCookie(c, cookieName)) return next();
    const { ctx, setCookies } = await resolveAuth(deps, auth, c.req.raw.headers);
    c.set("auth", ctx);
    await next();
    // The handler's own session cookie (sign-in, sign-out, rotation) wins over the refresh.
    const handlerSetsSession = c.res.headers.getSetCookie().some((v) => v.startsWith(`${cookieName}=`));
    if (handlerSetsSession) return;
    for (const cookie of setCookies) c.res.headers.append("set-cookie", cookie);
    if (!ctx && setCookies.length === 0) deleteCookie(c, cookieName, { path: "/" });
  };
}

/** 403 for a session whose second factor is still missing. */
export function mfaError(a: AuthContext): ApiError {
  return a.mfa === "enrollment_required"
    ? new ApiError(
        403,
        "mfa_enrollment_required",
        "Set up two-factor authentication (an authenticator app or a passkey) to continue.",
      )
    : new ApiError(403, "mfa_required", "Verify your second factor to continue.");
}

/**
 * Requires a signed-in user whose session satisfies MFA. This is the server-side
 * enrollment gate: everything outside /auth is mounted behind it, so a session
 * without a second factor can only reach /auth (me, enrollment, sign-out).
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = c.get("auth");
    if (!a) throw unauthorized();
    if (a.mfa !== "satisfied") throw mfaError(a);
    await next();
  };
}

/** Signed in, MFA state not checked (the /auth routes that enrollment needs). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("auth")) throw unauthorized();
  await next();
};

/** RBAC: requires at least `min` in the active organization. */
export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = c.get("auth");
    if (!a) throw unauthorized();
    if (ROLE_RANK[a.role] < ROLE_RANK[min])
      throw forbidden(
        min === "owner"
          ? "Only an owner of this organization can do that."
          : `You need the ${min === "admin" ? "Admin" : "Member"} role or higher to do that. Ask an admin.`,
      );
    await next();
  };
}

/** A user's own preferences, which viewers may change too (they touch no org data). */
const SELF_SERVICE_WRITES = new Set([`${API_BASE}/onboarding`]);

/** Viewers are read-only everywhere: any non-GET needs `member`. Routes add stricter checks. */
export const writesNeedMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !SELF_SERVICE_WRITES.has(c.req.path)) {
    const a = c.get("auth");
    if (a && ROLE_RANK[a.role] < ROLE_RANK.member) throw forbidden("Viewers have read-only access.");
  }
  await next();
};
