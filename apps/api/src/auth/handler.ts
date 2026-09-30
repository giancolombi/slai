/**
 * better-auth's HTTP surface, mounted at /api/v1/auth/* behind our middleware
 * (request id, CSRF, CORS, body limits, session loading). Only an allowlist of
 * endpoints is reachable; each one gets our rate limits, access rule (public,
 * any session, or MFA satisfied), enforce-SSO checks, audit events, and a
 * response normalized to the @slai/shared DTOs and `{error:{code,message}}`.
 * Session tokens never appear in a response body.
 */
import { createHash } from "node:crypto";
import { type AuditEntry, audit, organizations, sessions, ssoProviders, users, verifications } from "@slai/db";
import {
  deletePasskeyBody,
  disableTotpBody,
  loginBody,
  type Passkey,
  regenerateBackupCodesBody,
  type SecondFactor,
  type SignInResult,
  ssoSignInBody,
  type TotpEnrollment,
  totpEnableBody,
  verifyBackupCodeBody,
  verifyTotpBody,
} from "@slai/shared";
import { and, eq, gt, ilike } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import { type AppDeps, type AppEnv, type AuthContext, auditBase, type Ctx } from "../context.js";
import { ApiError, badRequest, conflict, notFound, unauthorized } from "../errors.js";
import { mfaError } from "../middleware/auth.js";
import { AUTH_BASE, type Auth, CLIENT_IP_HEADER, requestMeta, SESSION_COOKIE } from "./better-auth.js";
import { domainsOf, emailDomain } from "./domains.js";
import { buildMe, revokeByCookieValue } from "./me.js";
import { resolveAuth } from "./session.js";

type Access = "public" | "session" | "mfa";
const RULES: [RegExp, string[], Access][] = [
  [/^\/sign-in\/email$/, ["POST"], "public"],
  [/^\/sign-in\/sso$/, ["POST"], "public"],
  [/^\/sso\/callback\/[A-Za-z0-9_-]+$/, ["GET"], "public"],
  [/^\/sso\/saml2\/sp\/acs\/[A-Za-z0-9_-]+$/, ["POST"], "public"],
  [/^\/sso\/saml2\/sp\/metadata$/, ["GET"], "public"],
  // Public: sign-in completes with the 2FA challenge cookie; with a session it is enrollment or step-up.
  [/^\/two-factor\/verify-totp$/, ["POST"], "public"],
  [/^\/two-factor\/verify-backup-code$/, ["POST"], "public"],
  [/^\/two-factor\/enable$/, ["POST"], "session"],
  [/^\/two-factor\/generate-backup-codes$/, ["POST"], "mfa"],
  [/^\/two-factor\/disable$/, ["POST"], "mfa"],
  [/^\/passkey\/generate-register-options$/, ["GET"], "session"],
  [/^\/passkey\/verify-registration$/, ["POST"], "session"],
  [/^\/passkey\/generate-authenticate-options$/, ["GET"], "public"],
  [/^\/passkey\/verify-authentication$/, ["POST"], "public"],
  [/^\/passkey\/list-user-passkeys$/, ["GET"], "mfa"],
  [/^\/passkey\/delete-passkey$/, ["POST"], "mfa"],
];

const INVALID_LOGIN = () => new ApiError(401, "invalid_credentials", "Invalid email, password, or code.");
const RATE_LIMITED = () => new ApiError(429, "rate_limited", "Too many attempts. Try again later.");
export const SSO_REQUIRED = () =>
  new ApiError(403, "sso_required", "Your organization requires single sign-on. Continue with SSO.");
/** A TOTP code, once accepted, is refused for this long (covers the ±1 step window). */
const TOTP_REPLAY_MS = 2 * 60 * 1000;

/** better-auth error → our error (generic where it matters for enumeration). */
function toApiError(status: number, json: { code?: string; message?: string } | null): ApiError {
  switch (json?.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return INVALID_LOGIN();
    case "INVALID_CODE":
    case "INVALID_BACKUP_CODE":
    case "AUTHENTICATION_FAILED":
    case "PASSKEY_NOT_FOUND":
      return new ApiError(401, "invalid_code", "That code is not valid.");
    case "INVALID_TWO_FACTOR_COOKIE":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
    case "CHALLENGE_NOT_FOUND":
      return new ApiError(401, "mfa_challenge_expired", "That sign-in attempt expired. Sign in again.");
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return RATE_LIMITED();
    case "INVALID_PASSWORD":
      return new ApiError(400, "invalid_password", "That password is not correct.");
    case "TOTP_ALREADY_ENABLED":
      return conflict("An authenticator app is already set up.", "mfa_already_enabled");
    case "SESSION_NOT_FRESH":
      return new ApiError(403, "reauth_required", "Sign in again to make this change.");
  }
  if (status >= 500) return new ApiError(500, "internal", "Something went wrong.");
  if (status === 401) return unauthorized();
  if (status === 404) return notFound();
  return new ApiError(
    status as 400,
    (json?.code ?? "auth_error").toLowerCase(),
    json?.message ?? "The request could not be completed.",
  );
}

async function readJson<T = Record<string, unknown>>(res: Response): Promise<T | null> {
  try {
    return (await res.clone().json()) as T;
  } catch {
    return null;
  }
}

/** Is the email's domain covered by a verified SSO provider? (Domain-level only: no user lookup.) */
export async function ssoForEmail(
  deps: Pick<AppDeps, "authDb">,
  email: string,
): Promise<{ providerId: string; orgId: string; enforced: boolean } | null> {
  const domain = emailDomain(email);
  if (!domain) return null;
  const rows = await deps.authDb.db
    .select({
      providerId: ssoProviders.providerId,
      orgId: ssoProviders.orgId,
      domain: ssoProviders.domain,
      enforced: organizations.enforceSso,
    })
    .from(ssoProviders)
    .innerJoin(organizations, eq(organizations.id, ssoProviders.orgId))
    .where(
      and(eq(ssoProviders.domainVerified, true), ilike(ssoProviders.domain, `%${domain.replace(/[%_\\]/g, "")}%`)),
    );
  const matches = rows
    .filter((r) => domainsOf(r.domain).includes(domain))
    .sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
  const first = matches[0];
  return first ? { providerId: first.providerId, orgId: first.orgId, enforced: matches.some((m) => m.enforced) } : null;
}

export function authHandler(deps: AppDeps, auth: Auth) {
  const app = new Hono<AppEnv>();
  const db = deps.authDb.db;
  const cookieName = deps.env.NODE_ENV === "production" ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE;
  const appOrigin = new URL(deps.env.APP_URL).origin;

  const log = (c: Ctx, e: Omit<AuditEntry, "ip" | "userAgent" | "requestId" | "actor"> & Partial<AuditEntry>) =>
    audit(db, { ...auditBase(c), ...e });

  /** Calls better-auth with our resolved client IP (never a client-sent one). */
  const forward = (c: Ctx, body?: unknown, raw?: { text: string; type: string }): Promise<Response> => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    headers.delete("content-length");
    const ip = c.get("ip");
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    let payload: string | undefined;
    if (raw) {
      headers.set("content-type", raw.type);
      payload = raw.text;
    } else if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    const req = new Request(c.req.url, { method: c.req.method, headers, body: payload });
    const meta = {
      ip: c.get("ip"),
      userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null,
      requestId: c.get("requestId"),
    };
    return requestMeta.run(meta, () => auth.handler(req));
  };

  /** Our JSON response, carrying better-auth's Set-Cookie headers. */
  const reply = (c: Ctx, from: Response | null, payload: unknown, status = 200) => {
    const out = payload === null ? c.body(null, 204) : c.json(payload, status as 200);
    for (const v of from?.headers.getSetCookie() ?? []) out.headers.append("set-cookie", v);
    return out;
  };

  /** The session cookie value better-auth set on this response (not a deletion). */
  const issuedSession = (res: Response): string | null => {
    for (const v of res.headers.getSetCookie()) {
      const m = new RegExp(`^${cookieName}=([^;]+)`).exec(v);
      if (m?.[1]) return m[1];
    }
    return null;
  };

  /** Resolves the session better-auth just issued. */
  const newSession = async (res: Response): Promise<AuthContext | null> => {
    const value = issuedSession(res);
    if (!value) return null;
    return (await resolveAuth(deps, auth, new Headers({ cookie: `${cookieName}=${value}` }))).ctx;
  };

  /** Revokes the just-issued session and tells the browser to drop the cookie. */
  const discardSession = async (_c: Ctx, res: Response) => {
    const value = issuedSession(res);
    if (value) await revokeByCookieValue(db, value);
    const out = new Headers();
    out.append("set-cookie", `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return out;
  };

  const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
    const r = schema.safeParse(value);
    if (!r.success) throw badRequest("The request body is not valid.", r.error.issues);
    return r.data;
  };

  const limitIp = (c: Ctx) => {
    if (!deps.rateLimits.loginByIp.take(c.get("ip") ?? "unknown")) throw RATE_LIMITED();
  };

  /** Rejects a TOTP code this user already used (better-auth accepts ±1 step and keeps no replay record). */
  const totpReplayed = async (userId: string, code: string): Promise<boolean> => {
    const identifier = `slai-totp-used:${createHash("sha256").update(`${userId}:${code}`).digest("hex")}`;
    const now = new Date();
    const [seen] = await db
      .select({ id: verifications.id })
      .from(verifications)
      .where(and(eq(verifications.identifier, identifier), gt(verifications.expiresAt, now)));
    if (seen) return true;
    await db.insert(verifications).values({
      identifier,
      value: userId,
      expiresAt: new Date(now.getTime() + TOTP_REPLAY_MS),
    });
    return false;
  };

  const signedIn = async (c: Ctx, res: Response, a: AuthContext): Promise<Response> => {
    const me = await buildMe(db, a);
    const result: SignInResult =
      a.mfa === "satisfied"
        ? { status: "signed_in", me }
        : a.mfa === "enrollment_required"
          ? { status: "mfa_enrollment_required", me }
          : { status: "mfa_required", methods: methodsOf(a) };
    return reply(c, res, result);
  };

  app.all("*", async (c) => {
    const path = c.req.path.slice(AUTH_BASE.length) || "/";
    const rule = RULES.find(([re, methods]) => re.test(path) && methods.includes(c.req.method));
    if (!rule) throw notFound();
    const a = c.get("auth");
    if (rule[2] !== "public" && !a) throw unauthorized();
    if (rule[2] === "mfa" && a && a.mfa !== "satisfied") throw mfaError(a);

    let body: unknown;
    if (c.req.method === "POST" && !path.startsWith("/sso/saml2/")) {
      const text = await c.req.text();
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw badRequest("The request body must be JSON.");
      }
    }

    // ---------------------------------------------------------- password sign-in
    if (path === "/sign-in/email") {
      const input = parse(loginBody, body);
      const email = input.email.toLowerCase();
      if (!deps.rateLimits.loginByIp.take(c.get("ip") ?? "unknown") || !deps.rateLimits.loginByEmail.take(email)) {
        await log(c, {
          orgId: null,
          actor: { type: "user", id: null, name: email },
          action: "auth.login_rate_limited",
          target: { type: "user", id: null },
        });
        throw RATE_LIMITED();
      }
      const failed = (reason: string, userId: string | null = null) =>
        log(c, {
          orgId: null,
          actor: { type: "user", id: userId, name: email },
          action: "auth.login_failed",
          target: { type: "user", id: userId },
          metadata: { reason, method: "password" },
        });
      const sso = await ssoForEmail(deps, email);
      if (sso?.enforced) {
        await failed("sso_enforced");
        throw SSO_REQUIRED();
      }
      const res = await forward(c, { email, password: input.password, rememberMe: true });
      const json = await readJson<{ twoFactorRedirect?: boolean; user?: { id: string } }>(res);
      if (!res.ok) {
        await failed("bad_credentials");
        throw toApiError(res.status, json as never);
      }
      if (json?.twoFactorRedirect) {
        // Password verified; the TOTP challenge cookie is set, no session yet.
        const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
        await log(c, {
          orgId: null,
          actor: { type: "user", id: u?.id ?? null, name: email },
          action: "auth.password_verified",
          target: { type: "user", id: u?.id ?? null },
          metadata: { next: "second_factor" },
        });
        deps.rateLimits.loginByEmail.reset(email);
        const result: SignInResult = { status: "mfa_required", methods: ["totp", "backup_code"] };
        return reply(c, res, result);
      }
      const s = await newSession(res);
      if (!s) {
        // Disabled user or no organization: the issued session is revoked.
        await failed("unusable_account", json?.user?.id ?? null);
        const out = c.json(INVALID_LOGIN().body(), 401);
        for (const v of (await discardSession(c, res)).getSetCookie()) out.headers.append("set-cookie", v);
        return out;
      }
      deps.rateLimits.loginByEmail.reset(email);
      if (s.factors.passkeys > 0) {
        // Passkey-only users: the password alone never yields a session.
        const headers = await discardSession(c, res);
        await log(c, {
          orgId: null,
          actor: { type: "user", id: s.user.id, name: email },
          action: "auth.password_verified",
          target: { type: "user", id: s.user.id },
          metadata: { next: "passkey" },
        });
        const result: SignInResult = { status: "mfa_required", methods: ["passkey"] };
        const out = c.json(result);
        for (const v of headers.getSetCookie()) out.headers.append("set-cookie", v);
        return out;
      }
      await log(c, {
        orgId: s.orgId,
        actor: { type: "user", id: s.user.id, name: s.user.email },
        action: "auth.login",
        target: { type: "user", id: s.user.id },
        metadata: { method: "password", mfa: s.mfa },
      });
      return signedIn(c, res, s);
    }

    // ---------------------------------------------------------- second factor (sign-in, enrollment, step-up)
    if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code") {
      limitIp(c);
      const isTotp = path.endsWith("totp");
      const input = isTotp ? parse(verifyTotpBody, body) : parse(verifyBackupCodeBody, body);
      const factor: SecondFactor = isTotp ? "totp" : "backup_code";
      // Trusted devices are off: every sign-in needs the second factor.
      const res = await forward(c, { code: input.code, trustDevice: false });
      const json = await readJson<{ user?: { id: string; email: string } }>(res);
      if (!res.ok) {
        await log(c, {
          orgId: a?.orgId ?? null,
          ...(a ? {} : { actor: { type: "user" as const, id: null, name: null } }),
          action: a ? "auth.mfa_failed" : "auth.login_failed",
          target: { type: "user", id: a?.user.id ?? null },
          metadata: { reason: isTotp ? "bad_totp" : "bad_backup_code", method: factor },
        });
        throw toApiError(res.status, json as never);
      }
      const userId = json?.user?.id ?? a?.user.id ?? null;
      if (isTotp && userId && (await totpReplayed(userId, input.code))) {
        const headers = a ? new Headers() : await discardSession(c, res);
        await log(c, {
          orgId: a?.orgId ?? null,
          actor: { type: "user", id: userId, name: json?.user?.email ?? null },
          action: a ? "auth.mfa_failed" : "auth.login_failed",
          target: { type: "user", id: userId },
          metadata: { reason: "totp_replayed", method: factor },
        });
        const out = c.json(new ApiError(401, "invalid_code", "That code is not valid.").body(), 401);
        for (const v of headers.getSetCookie()) out.headers.append("set-cookie", v);
        return out;
      }
      if (a && !issuedSession(res)) {
        // Step-up in the current session (no new session issued): record the verification on it.
        await db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, a.sessionId));
      }
      const s = (await newSession(res)) ?? (a ? (await resolveAuth(deps, auth, c.req.raw.headers)).ctx : null);
      if (!s) throw unauthorized();
      const base = { orgId: s.orgId, actor: { type: "user" as const, id: s.user.id, name: s.user.email } };
      if (!a) {
        await log(c, {
          ...base,
          action: "auth.login",
          target: { type: "user", id: s.user.id },
          metadata: { method: "password", secondFactor: factor },
        });
      } else if (isTotp && !a.factors.totp) {
        await log(c, {
          ...base,
          action: "auth.mfa_enabled",
          target: { type: "user", id: s.user.id },
          metadata: { factor: "totp" },
        });
      } else {
        await log(c, {
          ...base,
          action: "auth.mfa_verified",
          target: { type: "user", id: s.user.id },
          metadata: { factor },
        });
      }
      if (!isTotp) {
        await log(c, { ...base, action: "auth.backup_code_used", target: { type: "user", id: s.user.id } });
      }
      return signedIn(c, res, s);
    }

    // ---------------------------------------------------------- TOTP enrollment and management (session)
    const me = a!;
    if (path === "/two-factor/enable") {
      const input = parse(totpEnableBody, body);
      const res = await forward(c, { password: input.password, method: "totp" });
      const json = await readJson<{ totpURI?: string; backupCodes?: string[] }>(res);
      if (!res.ok || !json?.totpURI) throw toApiError(res.status, json as never);
      await log(c, { orgId: me.orgId, action: "auth.mfa_setup_started", target: { type: "user", id: me.user.id } });
      const secret = new URL(json.totpURI).searchParams.get("secret") ?? "";
      const out: TotpEnrollment = { otpauthUrl: json.totpURI, secret, backupCodes: json.backupCodes ?? [] };
      return reply(c, res, out);
    }
    if (path === "/two-factor/generate-backup-codes") {
      const input = parse(regenerateBackupCodesBody, body);
      const res = await forward(c, { password: input.password });
      const json = await readJson<{ backupCodes?: string[] }>(res);
      if (!res.ok) throw toApiError(res.status, json as never);
      await log(c, {
        orgId: me.orgId,
        action: "auth.backup_codes_regenerated",
        target: { type: "user", id: me.user.id },
      });
      return reply(c, res, { backupCodes: json?.backupCodes ?? [] });
    }
    if (path === "/two-factor/disable") {
      const input = parse(disableTotpBody, body);
      if (me.authMethod !== "sso" && me.factors.passkeys === 0) {
        throw conflict(
          "Add a passkey before removing your authenticator app: a second factor is required.",
          "last_factor",
        );
      }
      const res = await forward(c, { password: input.password });
      if (!res.ok) throw toApiError(res.status, await readJson(res));
      await log(c, {
        orgId: me.orgId,
        action: "auth.mfa_disabled",
        target: { type: "user", id: me.user.id },
        metadata: { factor: "totp" },
      });
      return reply(c, res, null);
    }

    // ---------------------------------------------------------- passkeys
    if (path === "/passkey/generate-register-options" || path === "/passkey/generate-authenticate-options") {
      if (path.endsWith("authenticate-options")) limitIp(c);
      const res = await forward(c, body);
      if (!res.ok) throw toApiError(res.status, await readJson(res));
      return reply(c, res, await readJson(res));
    }
    if (path === "/passkey/verify-registration") {
      const res = await forward(c, { ...(body as object), createSession: false });
      const json = await readJson<{
        id: string;
        name?: string | null;
        deviceType: string;
        backedUp: boolean;
        createdAt: string;
      }>(res);
      if (!res.ok || !json) throw toApiError(res.status, json as never);
      // Registering a passkey is enrollment: this password session now has a second factor.
      await db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, me.sessionId));
      await log(c, { orgId: me.orgId, action: "auth.passkey_added", target: { type: "passkey", id: json.id } });
      const out: Passkey = {
        id: json.id,
        name: json.name ?? null,
        deviceType: json.deviceType,
        backedUp: json.backedUp,
        createdAt: new Date(json.createdAt).toISOString(),
      };
      return reply(c, res, out);
    }
    if (path === "/passkey/verify-authentication") {
      limitIp(c);
      const res = await forward(c, body);
      if (!res.ok) {
        await log(c, {
          orgId: null,
          actor: { type: "user", id: null, name: null },
          action: "auth.login_failed",
          target: { type: "user", id: null },
          metadata: { reason: "bad_passkey", method: "passkey" },
        });
        throw toApiError(res.status, await readJson(res));
      }
      const s = await newSession(res);
      if (!s) throw INVALID_LOGIN();
      if ((await ssoForEmail(deps, s.user.email))?.enforced) {
        const headers = await discardSession(c, res);
        await log(c, {
          orgId: null,
          actor: { type: "user", id: s.user.id, name: s.user.email },
          action: "auth.login_failed",
          target: { type: "user", id: s.user.id },
          metadata: { reason: "sso_enforced", method: "passkey" },
        });
        const out = c.json(SSO_REQUIRED().body(), 403);
        for (const v of headers.getSetCookie()) out.headers.append("set-cookie", v);
        return out;
      }
      await log(c, {
        orgId: s.orgId,
        actor: { type: "user", id: s.user.id, name: s.user.email },
        action: "auth.login",
        target: { type: "user", id: s.user.id },
        metadata: { method: "passkey" },
      });
      return signedIn(c, res, s);
    }
    if (path === "/passkey/list-user-passkeys") {
      const res = await forward(c);
      const json =
        await readJson<
          { id: string; name?: string | null; deviceType: string; backedUp: boolean; createdAt: string }[]
        >(res);
      if (!res.ok || !json) throw toApiError(res.status, json as never);
      const out: Passkey[] = json.map((p) => ({
        id: p.id,
        name: p.name ?? null,
        deviceType: p.deviceType,
        backedUp: p.backedUp,
        createdAt: new Date(p.createdAt).toISOString(),
      }));
      return reply(c, res, out);
    }
    if (path === "/passkey/delete-passkey") {
      const input = parse(deletePasskeyBody, body);
      if (me.authMethod !== "sso" && !me.factors.totp && me.factors.passkeys <= 1) {
        throw conflict(
          "Keep at least one second factor: add an authenticator app or another passkey first.",
          "last_factor",
        );
      }
      const res = await forward(c, input);
      if (!res.ok) throw toApiError(res.status, await readJson(res));
      await log(c, { orgId: me.orgId, action: "auth.passkey_removed", target: { type: "passkey", id: input.id } });
      return reply(c, res, null);
    }

    // ---------------------------------------------------------- SSO
    if (path === "/sign-in/sso") {
      limitIp(c);
      const input = parse(ssoSignInBody, body);
      const res = await forward(c, {
        ...(input.email ? { email: input.email.toLowerCase() } : { providerId: input.providerId }),
        callbackURL: `${appOrigin}${input.redirect ?? "/"}`,
        errorCallbackURL: `${appOrigin}/login?sso_error=1`,
      });
      const json = await readJson<{ url?: string }>(res);
      if (!res.ok || !json?.url) {
        if (res.status >= 500) throw toApiError(res.status, json as never);
        throw new ApiError(404, "sso_not_configured", "Single sign-on is not set up for this email domain.");
      }
      return reply(c, res, { url: json.url });
    }
    if (path === "/sso/saml2/sp/metadata") return forward(c);
    // OIDC callback or SAML ACS: better-auth sets the session and redirects to the app.
    const providerId = path.split("/").at(-1) ?? null;
    const res = path.startsWith("/sso/saml2/")
      ? await forward(c, undefined, {
          text: await c.req.text(),
          type: c.req.header("content-type") ?? "application/x-www-form-urlencoded",
        })
      : await forward(c);
    const s = await newSession(res);
    if (s) {
      await log(c, {
        orgId: s.orgId,
        actor: { type: "user", id: s.user.id, name: s.user.email },
        action: "auth.login",
        target: { type: "user", id: s.user.id },
        metadata: { method: "sso", providerId, mfa: s.mfa },
      });
    } else {
      await log(c, {
        orgId: null,
        actor: { type: "user", id: null, name: null },
        action: "auth.login_failed",
        target: { type: "sso_provider", id: providerId },
        metadata: { reason: "sso_error", method: "sso" },
      });
    }
    return res;
  });

  return app;
}

function methodsOf(a: AuthContext): SecondFactor[] {
  const m: SecondFactor[] = [];
  if (a.factors.totp) m.push("totp", "backup_code");
  if (a.factors.passkeys > 0) m.push("passkey");
  return m;
}
