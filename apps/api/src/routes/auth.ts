import { randomBytes } from "node:crypto";
import {
  AAD,
  audit,
  burnPasswordCheck,
  decrypt,
  type Executor,
  encrypt,
  hashPassword,
  memberships,
  organizations,
  sessions,
  users,
  verifyPassword,
} from "@slai/db";
import { loginBody, type Me, mfaVerifyBody, type Role, signupBody, switchOrgBody } from "@slai/shared";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { type AppDeps, type AppEnv, type AuthContext, auditBase, auth, type Ctx } from "../context.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { ABSOLUTE_TIMEOUT_MS, createSession, SESSION_COOKIE } from "../sessions.js";
import { generateSecret, otpauthUrl, verifyTotp } from "../totp.js";
import { body } from "../validate.js";

const INVALID_LOGIN = () => new ApiError(401, "invalid_credentials", "Invalid email, password, or code.");
const RATE_LIMITED = () => new ApiError(429, "rate_limited", "Too many attempts. Try again later.");

const mfaAad = AAD.userMfaSecret;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

export async function buildMe(db: Executor, a: Pick<AuthContext, "user" | "orgId" | "role">): Promise<Me> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      plan: organizations.plan,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, a.user.id))
    .orderBy(asc(memberships.createdAt));
  const active = rows.find((r) => r.id === a.orgId);
  if (!active) throw notFound("Organization");
  return {
    user: a.user,
    organization: { id: active.id, name: active.name, slug: active.slug, plan: active.plan },
    role: a.role,
    organizations: rows.map((r) => ({ id: r.id, name: r.name, role: r.role as Role })),
  };
}

export function authRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const sys = deps.systemDb.db;

  const setSessionCookie = (c: Ctx, token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: deps.env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: ABSOLUTE_TIMEOUT_MS / 1000,
    });

  app.post("/signup", async (c) => {
    if (!deps.rateLimits.loginByIp.take(`signup:${c.get("ip") ?? "unknown"}`)) throw RATE_LIMITED();
    const input = await body(c, signupBody);
    const passwordHash = await hashPassword(input.password);
    const now = deps.now();
    const result = await sys.transaction(async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
      if (existing) return null;
      const [user] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash, lastLoginAt: now })
        .returning();
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.organizationName, slug: slugify(input.organizationName) })
        .returning();
      await tx.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: "owner" });
      const token = await createSession(tx, {
        userId: user!.id,
        orgId: org!.id,
        mfaVerified: false,
        ip: c.get("ip"),
        userAgent: c.req.header("user-agent") ?? null,
        now,
      });
      const a = {
        user: { id: user!.id, email: user!.email, name: user!.name, mfaEnabled: false },
        orgId: org!.id,
        role: "owner" as const,
      };
      await audit(tx, {
        ...auditBase(c),
        actor: { type: "user", id: user!.id, name: user!.email },
        orgId: org!.id,
        action: "auth.signup",
        target: { type: "organization", id: org!.id },
      });
      return { token, me: await buildMe(tx, a) };
    });
    if (!result) throw conflict("Unable to create an account with this email.", "signup_failed");
    setSessionCookie(c, result.token);
    return c.json(result.me, 201);
  });

  app.post("/login", async (c) => {
    const input = await body(c, loginBody);
    const email = input.email.toLowerCase();
    const ipKey = c.get("ip") ?? "unknown";
    if (!deps.rateLimits.loginByIp.take(ipKey) || !deps.rateLimits.loginByEmail.take(email)) {
      await audit(sys, {
        ...auditBase(c),
        orgId: null,
        action: "auth.login_rate_limited",
        target: { type: "user", id: null },
        metadata: { email },
      });
      throw RATE_LIMITED();
    }
    const [user] = await sys.select().from(users).where(eq(users.email, email));
    const failed = async (reason: string) => {
      await audit(sys, {
        ...auditBase(c),
        orgId: null,
        actor: { type: "user", id: user?.id ?? null, name: email },
        action: "auth.login_failed",
        target: { type: "user", id: user?.id ?? null },
        metadata: { reason },
      });
      return INVALID_LOGIN();
    };
    if (!user || user.disabledAt) {
      await burnPasswordCheck(input.password);
      throw await failed(user ? "disabled" : "unknown_email");
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) throw await failed("bad_password");

    const now = deps.now();
    if (user.mfaEnabled) {
      if (!input.totp) throw new ApiError(401, "mfa_required", "Enter the code from your authenticator app.");
      const step = user.mfaSecret
        ? verifyTotp(
            decrypt(user.mfaSecret, { keyring: deps.keyring, aad: mfaAad(user.id) }),
            input.totp,
            now,
            user.mfaLastStep,
          )
        : null;
      if (step === null) throw await failed("bad_totp");
      await sys.update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
    }

    const [membership] = await sys
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (!membership) throw await failed("no_organization");

    const token = await sys.transaction(async (tx) => {
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      const t = await createSession(tx, {
        userId: user.id,
        orgId: membership.orgId,
        mfaVerified: user.mfaEnabled,
        ip: c.get("ip"),
        userAgent: c.req.header("user-agent") ?? null,
        now,
      });
      await audit(tx, {
        ...auditBase(c),
        actor: { type: "user", id: user.id, name: user.email },
        orgId: membership.orgId,
        action: "auth.login",
        target: { type: "user", id: user.id },
        metadata: { mfa: user.mfaEnabled },
      });
      return t;
    });
    deps.rateLimits.loginByEmail.reset(email);
    setSessionCookie(c, token);
    const me = await buildMe(sys, {
      user: { id: user.id, email: user.email, name: user.name, mfaEnabled: user.mfaEnabled },
      orgId: membership.orgId,
      role: membership.role as Role,
    });
    return c.json(me);
  });

  const signedIn = requireAuth({ allowMfaPending: true });

  app.post("/logout", signedIn, async (c) => {
    const a = auth(c);
    await sys.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, a.sessionId));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "auth.logout",
        target: { type: "user", id: a.user.id },
      });
    });
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/me", signedIn, async (c) => c.json(await buildMe(sys, auth(c))));

  app.post("/mfa/setup", signedIn, async (c) => {
    const a = auth(c);
    if (a.user.mfaEnabled) throw conflict("Two-factor authentication is already enabled.", "mfa_already_enabled");
    const secret = generateSecret();
    await sys.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ mfaSecret: encrypt(secret, { keyring: deps.keyring, aad: mfaAad(a.user.id) }), mfaLastStep: null })
        .where(eq(users.id, a.user.id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "auth.mfa_setup_started",
        target: { type: "user", id: a.user.id },
      });
    });
    return c.json({ otpauthUrl: otpauthUrl(secret, a.user.email), secret });
  });

  app.post("/mfa/verify", signedIn, async (c) => {
    const a = auth(c);
    const input = await body(c, mfaVerifyBody);
    const [user] = await sys.select().from(users).where(eq(users.id, a.user.id));
    if (!user?.mfaSecret) throw new ApiError(400, "mfa_not_setup", "Start two-factor setup first.");
    const secret = decrypt(user.mfaSecret, { keyring: deps.keyring, aad: mfaAad(user.id) });
    const now = deps.now();
    const step = verifyTotp(secret, input.totp, now, user.mfaLastStep);
    if (step === null) {
      await audit(sys, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "auth.mfa_failed",
        target: { type: "user", id: a.user.id },
      });
      throw new ApiError(401, "invalid_code", "That code is not valid.");
    }
    // Privilege change: rotate the session token (prevents fixation).
    const token = await sys.transaction(async (tx) => {
      await tx.update(users).set({ mfaEnabled: true, mfaLastStep: step }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(eq(sessions.id, a.sessionId));
      const t = await createSession(tx, {
        userId: user.id,
        orgId: a.orgId,
        mfaVerified: true,
        ip: c.get("ip"),
        userAgent: c.req.header("user-agent") ?? null,
        now,
      });
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: user.mfaEnabled ? "auth.mfa_verified" : "auth.mfa_enabled",
        target: { type: "user", id: user.id },
      });
      return t;
    });
    setSessionCookie(c, token);
    return c.json(await buildMe(sys, { ...a, user: { ...a.user, mfaEnabled: true } }));
  });

  app.post("/switch-org", signedIn, async (c) => {
    const a = auth(c);
    const input = await body(c, switchOrgBody);
    const [m] = await sys
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, a.user.id), eq(memberships.orgId, input.organizationId)));
    if (!m) throw notFound("Organization");
    await sys.transaction(async (tx) => {
      await tx.update(sessions).set({ activeOrgId: input.organizationId }).where(eq(sessions.id, a.sessionId));
      await audit(tx, {
        ...auditBase(c),
        orgId: input.organizationId,
        action: "auth.org_switched",
        target: { type: "organization", id: input.organizationId },
        metadata: { from: a.orgId },
      });
    });
    return c.json(await buildMe(sys, { user: a.user, orgId: input.organizationId, role: m.role as Role }));
  });

  return app;
}
