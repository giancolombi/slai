import type { Role } from "@slai/shared";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { type AppDeps, type AppEnv, ROLE_RANK } from "../context.js";
import { ApiError, forbidden, unauthorized } from "../errors.js";
import { resolveSession, SESSION_COOKIE } from "../sessions.js";

/** Loads the session (if any) from the `slai_session` cookie into `c.var.auth`. */
export function loadSession(deps: Pick<AppDeps, "systemDb" | "now">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) c.set("auth", await resolveSession(deps.systemDb.db, token, deps.now()));
    await next();
  };
}

/**
 * Requires a signed-in user. Unless `allowMfaPending`, a session that has not
 * completed MFA (when the user has MFA, or the org requires it) is refused with
 * 403 `mfa_setup_required`, so the only things it can do are set up MFA, read
 * /auth/me, switch org, and log out.
 */
export function requireAuth(opts: { allowMfaPending?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = c.get("auth");
    if (!a) throw unauthorized();
    const needsMfa = (a.user.mfaEnabled || a.orgRequiresMfa) && !a.mfaVerified;
    if (needsMfa && !opts.allowMfaPending) {
      throw new ApiError(403, "mfa_setup_required", "This organization requires two-factor authentication.");
    }
    await next();
  };
}

/** RBAC: requires at least `min` in the active organization. */
export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const a = c.get("auth");
    if (!a) throw unauthorized();
    if (ROLE_RANK[a.role] < ROLE_RANK[min]) throw forbidden(`Requires the ${min} role or higher.`);
    await next();
  };
}

/** Viewers are read-only everywhere: any non-GET needs `member`. Routes add stricter checks. */
export const writesNeedMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const a = c.get("auth");
    if (a && ROLE_RANK[a.role] < ROLE_RANK.member) throw forbidden("Viewers have read-only access.");
  }
  await next();
};
