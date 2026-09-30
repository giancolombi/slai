import { randomBytes } from "node:crypto";
import { audit, memberships, organizations, sessions, users } from "@slai/db";
import { discoverBody, type SignInDiscovery, type SignInResult, signupBody, switchOrgBody } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Auth } from "../auth/better-auth.js";
import { CLIENT_IP_HEADER, SESSION_COOKIE } from "../auth/better-auth.js";
import { SSO_REQUIRED, ssoForEmail } from "../auth/handler.js";
import { buildMe } from "../auth/me.js";
import { resolveAuth } from "../auth/session.js";
import { type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { requireSession } from "../middleware/auth.js";
import { body } from "../validate.js";

const RATE_LIMITED = () => new ApiError(429, "rate_limited", "Too many attempts. Try again later.");

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

/** Our own /auth routes; better-auth's allowlisted endpoints are mounted after these (handler.ts). */
export function authRoutes(deps: AppDeps, betterAuth: Auth) {
  const app = new Hono<AppEnv>();
  const db = deps.authDb.db;
  const cookieName = deps.env.NODE_ENV === "production" ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE;

  const authHeaders = (c: Ctx) => {
    const h = new Headers(c.req.raw.headers);
    h.delete(CLIENT_IP_HEADER);
    const ip = c.get("ip");
    if (ip) h.set(CLIENT_IP_HEADER, ip);
    return h;
  };

  app.post("/signup", async (c) => {
    if (!deps.rateLimits.loginByIp.take(`signup:${c.get("ip") ?? "unknown"}`)) throw RATE_LIMITED();
    const input = await body(c, signupBody);
    const email = input.email.toLowerCase();
    if ((await ssoForEmail(deps, email))?.enforced) throw SSO_REQUIRED();
    let created: { headers: Headers; response: { user: { id: string } } };
    try {
      created = (await betterAuth.api.signUpEmail({
        body: { email, password: input.password, name: input.name },
        headers: authHeaders(c),
        returnHeaders: true,
      })) as typeof created;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      if (status >= 500) throw e;
      throw conflict("Unable to create an account with this email.", "signup_failed");
    }
    const userId = created.response.user.id;
    try {
      await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organizations)
          .values({ name: input.organizationName, slug: slugify(input.organizationName) })
          .returning();
        await tx.insert(memberships).values({ orgId: org!.id, userId, role: "owner" });
        await tx.update(sessions).set({ activeOrgId: org!.id }).where(eq(sessions.userId, userId));
        await audit(tx, {
          ...auditBase(c),
          actor: { type: "user", id: userId, name: email },
          orgId: org!.id,
          action: "auth.signup",
          target: { type: "organization", id: org!.id },
        });
      });
    } catch (e) {
      await db.delete(users).where(eq(users.id, userId)); // no orphan user without an org
      throw e;
    }
    const setCookies = created.headers.getSetCookie();
    const value = setCookies.map((v) => new RegExp(`^${cookieName}=([^;]+)`).exec(v)?.[1]).find(Boolean);
    const { ctx } = await resolveAuth(deps, betterAuth, new Headers({ cookie: `${cookieName}=${value ?? ""}` }));
    if (!ctx) throw new ApiError(500, "internal", "Account created, but signing in failed. Sign in again.");
    const result: SignInResult = { status: "mfa_enrollment_required", me: await buildMe(db, ctx) };
    const out = c.json(result, 201);
    for (const v of setCookies) out.headers.append("set-cookie", v);
    return out;
  });

  /** Email-first sign-in: SSO or password, decided by the email's domain only (no user lookup). */
  app.post("/discover", async (c) => {
    if (!deps.rateLimits.loginByIp.take(`discover:${c.get("ip") ?? "unknown"}`)) throw RATE_LIMITED();
    const input = await body(c, discoverBody);
    const sso = await ssoForEmail(deps, input.email);
    const out: SignInDiscovery = sso
      ? { method: "sso", providerId: sso.providerId, enforced: sso.enforced }
      : { method: "password" };
    return c.json(out);
  });

  app.post("/logout", requireSession, async (c) => {
    const a = auth(c);
    const res = await betterAuth.api.signOut({ headers: authHeaders(c), returnHeaders: true });
    await audit(db, {
      ...auditBase(c),
      orgId: a.orgId,
      action: "auth.logout",
      target: { type: "user", id: a.user.id },
    });
    const out = c.body(null, 204);
    for (const v of res.headers.getSetCookie()) out.headers.append("set-cookie", v);
    return out;
  });

  // Works while MFA is pending, so the web app can route to enrollment or verification.
  app.get("/me", requireSession, async (c) => c.json(await buildMe(db, auth(c))));

  app.post("/switch-org", requireSession, async (c) => {
    const a = auth(c);
    const input = await body(c, switchOrgBody);
    const [m] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, a.user.id), eq(memberships.orgId, input.organizationId)));
    if (!m) throw notFound("Organization");
    await db.transaction(async (tx) => {
      await tx.update(sessions).set({ activeOrgId: input.organizationId }).where(eq(sessions.id, a.sessionId));
      await audit(tx, {
        ...auditBase(c),
        orgId: input.organizationId,
        action: "auth.org_switched",
        target: { type: "organization", id: input.organizationId },
        metadata: { from: a.orgId },
      });
    });
    // The MFA state can differ per org (SSO trust is per org), so re-resolve.
    const { ctx } = await resolveAuth(deps, betterAuth, c.req.raw.headers);
    if (!ctx) throw notFound("Organization");
    return c.json(await buildMe(db, ctx));
  });

  return app;
}
