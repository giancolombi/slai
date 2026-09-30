/**
 * The better-auth instance (TR-23). It owns credentials, sessions, TOTP and
 * backup codes, passkeys, and the OIDC/SAML protocol work; slai owns
 * organizations, memberships, roles, RBAC, audit, and the MFA gate.
 *
 * - Storage: our tables through the Drizzle adapter on the `slai_auth` role,
 *   wrapped by `sealAdapter` (sha256 session tokens, sealed SSO secrets).
 * - Passwords: argon2id via `@slai/db` (existing hashes keep working).
 * - Sessions: httpOnly `slai_session`, SameSite=Lax, Secure in production;
 *   12h sliding idle expiry. The 7-day absolute limit is enforced by
 *   `resolveAuth` (created_at + 7d).
 * - The HTTP surface is not exposed directly: `authHandler` (handler.ts) mounts
 *   an allowlist of endpoints behind our CSRF, rate-limit and audit middleware.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import {
  accounts,
  audit,
  authSecrets,
  hashPassword,
  memberships,
  passkeys,
  sessions,
  ssoProviders,
  twoFactors,
  users,
  verifications,
  verifyPassword,
} from "@slai/db";
import { API_BASE } from "@slai/shared";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AppDeps } from "../context.js";
import { domainsOf, emailDomain } from "./domains.js";
import { type IdpAuthn, oidcAuthn } from "./idp-mfa.js";
import { sealAdapter } from "./sealing-adapter.js";

export const AUTH_BASE = `${API_BASE}/auth`;
export const SESSION_COOKIE = "slai_session";
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** Set by our handler from the resolved client IP; any client-sent value is overwritten. */
export const CLIENT_IP_HEADER = "x-slai-client-ip";

/** Request metadata for audit rows written inside better-auth callbacks (JIT provisioning). */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  /** Set during an OIDC callback: the verified ID token's `amr`/`acr` (the handler records and enforces them). */
  idp?: IdpAuthn;
}
export const requestMeta = new AsyncLocalStorage<RequestMeta>();

type AuthDeps = Pick<AppDeps, "env" | "authDb" | "keyring" | "logger">;

/** How a new session was established, from the better-auth endpoint that created it. */
function sessionOrigin(path: string): { authMethod: string; mfaVerified: boolean } | null {
  if (path === "/sign-in/email" || path === "/sign-up/email") return { authMethod: "password", mfaVerified: false };
  if (path === "/passkey/verify-authentication") return { authMethod: "passkey", mfaVerified: true };
  if (path.startsWith("/sso/")) return { authMethod: "sso", mfaVerified: false };
  return null;
}

export function createAuth(deps: AuthDeps) {
  const { env } = deps;
  const db = deps.authDb.db;
  const appOrigin = new URL(env.APP_URL).origin;
  const secure = env.NODE_ENV === "production";

  /** The org owning an SSO provider (for session tagging and the JIT/domain guards). */
  const providerById = async (providerId: unknown) => {
    if (typeof providerId !== "string") return undefined;
    const [p] = await db.select().from(ssoProviders).where(eq(ssoProviders.providerId, providerId));
    return p;
  };

  return betterAuth({
    appName: "slai",
    baseURL: env.API_URL,
    basePath: AUTH_BASE,
    secrets: authSecrets(env.SESSION_SECRET, {
      version: env.SESSION_SECRET_VERSION,
      previous: env.SESSION_SECRETS_PREVIOUS,
    }),
    // callbackURLs may only point at the web app. Internal IdPs are an operator allowlist.
    trustedOrigins: [appOrigin, ...env.SSO_TRUSTED_IDP_ORIGINS],
    telemetry: { enabled: false },
    logger: {
      level: "error",
      log: (level, message) => deps.logger[level]({ component: "better-auth" }, message),
    },
    database: (options: BetterAuthOptions) =>
      sealAdapter(
        drizzleAdapter(db, {
          provider: "pg",
          transaction: true,
          schema: { users, sessions, accounts, verifications, twoFactors, passkeys, ssoProviders },
        })(options),
        deps.keyring,
      ),
    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      fields: { token: "tokenHash", ipAddress: "ip" },
      expiresIn: IDLE_TIMEOUT_MS / 1000,
      // Slide the idle window at most once a minute per session (one UPDATE).
      updateAge: 60,
      // Adding a passkey needs a session younger than this.
      freshAge: IDLE_TIMEOUT_MS / 1000,
      additionalFields: {
        activeOrgId: { type: "string", required: false, input: false },
        authMethod: { type: "string", required: false, input: false },
        mfaVerified: { type: "boolean", required: false, input: false },
        ssoOrgId: { type: "string", required: false, input: false },
        stepUpAt: { type: "date", required: false, input: false },
      },
    },
    account: {
      modelName: "accounts",
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: [] },
    },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(hash, password) },
    },
    // Our TokenBuckets (handler.ts) limit sign-in by IP and by email; the twoFactor
    // plugin's own lockout still applies (10 bad codes lock TOTP for 15 minutes).
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: "slai",
      cookies: { session_token: { name: SESSION_COOKIE } },
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure, path: "/" },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: false },
    },
    databaseHooks: {
      user: {
        create: {
          // JIT users from an IdP must have an email on that provider's verified domain.
          before: async (user, ctx) => {
            const path = ctx?.path ?? "";
            if (!path.startsWith("/sso/")) return;
            const provider = await providerById(ctx?.params?.providerId);
            const domain = emailDomain(user.email);
            if (!provider?.domainVerified || !domain || !domainsOf(provider.domain).includes(domain)) return false;
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const s = session as typeof session & Record<string, unknown>;
            const path = ctx?.path ?? "";
            const origin = sessionOrigin(path);
            const data: Record<string, unknown> = { ...s };
            if (origin) Object.assign(data, origin);
            // Verifying a second factor (sign-in, enrollment or step-up) satisfies MFA;
            // enrollment copies the old session, so its auth method is kept.
            if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code") {
              data.authMethod = s.authMethod ?? "password";
              data.mfaVerified = true;
            }
            // A TOTP code or a passkey was just proven: fresh for step-up (a backup code is not).
            if (path === "/two-factor/verify-totp" || origin?.authMethod === "passkey") data.stepUpAt = new Date();
            if (origin?.authMethod === "sso") {
              const provider = await providerById(ctx?.params?.providerId);
              data.ssoOrgId = provider?.orgId ?? null;
              data.activeOrgId = provider?.orgId ?? null;
            }
            if (!data.activeOrgId) {
              const [m] = await db
                .select({ orgId: memberships.orgId })
                .from(memberships)
                .where(and(eq(memberships.userId, s.userId), isNull(memberships.disabledAt)))
                .orderBy(asc(memberships.createdAt))
                .limit(1);
              data.activeOrgId = m?.orgId ?? null;
            }
            return { data: data as typeof session };
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: "slai",
        // Users without a password (SSO-only) may enroll without one; everyone else re-enters it.
        allowPasswordless: true,
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
        schema: {
          user: { fields: { twoFactorEnabled: "mfaEnabled" } },
          twoFactor: { modelName: "twoFactors" },
        },
      }),
      passkey({
        rpID: new URL(env.APP_URL).hostname,
        rpName: "slai",
        origin: appOrigin,
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        // A passkey is a full second factor only with user verification (PIN/biometric).
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) throw new Error("user verification required");
          },
        },
        schema: { passkey: { modelName: "passkeys" } },
      }),
      sso({
        modelName: "ssoProviders",
        fields: { organizationId: "orgId" },
        // Providers are written by our /org/sso routes (RBAC, audit, sealing), never by better-auth's.
        providersLimit: 0,
        domainVerification: { enabled: true },
        disableImplicitSignUp: false,
        defaultOverrideUserInfo: false,
        provisionUserOnEveryLogin: true,
        // JIT: a user signing in through an org's IdP becomes a `member` of that org.
        provisionUser: async ({ user, provider, token }) => {
          // OIDC: better-auth verified the ID token (JWKS, iss, aud) before calling us.
          const store = requestMeta.getStore();
          if (store && token?.idToken) store.idp = oidcAuthn(token.idToken);
          const orgId = (provider as { organizationId?: string | null }).organizationId;
          if (!orgId) return;
          const [created] = await db
            .insert(memberships)
            .values({ orgId, userId: user.id, role: "member" })
            .onConflictDoNothing()
            .returning({ id: memberships.id });
          if (!created) return;
          const meta = requestMeta.getStore();
          await audit(db, {
            orgId,
            actor: { type: "user", id: user.id, name: user.email },
            action: "sso.jit_provisioned",
            target: { type: "user", id: user.id },
            metadata: { providerId: provider.providerId, role: "member" },
            ip: meta?.ip ?? null,
            userAgent: meta?.userAgent ?? null,
            requestId: meta?.requestId ?? null,
          });
        },
        saml: { allowIdpInitiated: false },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
