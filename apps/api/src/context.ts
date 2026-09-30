import type { getConnector } from "@slai/connectors";
import type { AuditEntry, Database, JobSender, Keyring, OrgDatabase, StorageDriver } from "@slai/db";
import type { AuthMethod, MfaState, Role } from "@slai/shared";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { BillingGateway } from "./billing/stripe.js";
import type { Env } from "./env.js";
import { unauthorized } from "./errors.js";
import type { EventHub } from "./events-hub.js";
import type { RateLimits, SharedRateLimiter } from "./rate-limit.js";

/** A connector definition with its credentials type erased (as the registry returns it). */
export type AnyConnector = NonNullable<ReturnType<typeof getConnector>>;

export interface ConnectorRegistry {
  get(provider: string): AnyConnector | null;
  list(): AnyConnector[];
}

export interface AppDeps {
  env: Env;
  /** slai_app: every org-scoped query goes through `orgDb.withOrg`. */
  orgDb: OrgDatabase;
  /** slai_worker: webhook routing and the SSE listener only. */
  systemDb: Database;
  /** slai_auth: better-auth's identity tables, session resolution, signup and SSO JIT. */
  authDb: Database;
  /** DNS TXT lookup for SSO domain verification (tests pass a fake). */
  resolveTxt: (hostname: string) => Promise<string[][]>;
  jobs: JobSender;
  storage: StorageDriver;
  connectors: ConnectorRegistry;
  /** Injected into connectors (tests pass a fake). */
  fetch: typeof fetch;
  keyring: Keyring;
  logger: Logger;
  rateLimits: RateLimits;
  /** Shared (multi-replica) limits, when RATE_LIMIT_STORE=postgres. */
  sharedRateLimit?: SharedRateLimiter;
  events: EventHub;
  now: () => Date;
  /** Stripe billing (T-65); absent or null in manual mode (no STRIPE_SECRET_KEY). */
  billing?: BillingGateway | null;
  /** Checks the database for /readyz. */
  ready?: () => Promise<boolean>;
}

export interface AuthContext {
  sessionId: string;
  user: { id: string; email: string; name: string; mfaEnabled: boolean };
  /** The active organization and the user's role in it. */
  orgId: string;
  role: Role;
  authMethod: AuthMethod;
  /** Anything but `satisfied` blocks every route outside /auth (requireAuth). */
  mfa: MfaState;
  factors: { totp: boolean; passkeys: number; hasPassword: boolean };
}

export type AppEnv = {
  Variables: {
    requestId: string;
    ip: string | null;
    auth: AuthContext | null;
  };
};

export type Ctx = Context<AppEnv>;

export function auth(c: Ctx): AuthContext {
  const a = c.get("auth");
  if (!a) throw unauthorized();
  return a;
}

/** Common audit fields for the current request and user. */
export function auditBase(c: Ctx): Pick<AuditEntry, "actor" | "ip" | "userAgent" | "requestId"> {
  const a = c.get("auth");
  return {
    actor: a ? { type: "user", id: a.user.id, name: a.user.email } : { type: "system", id: null, name: null },
    ip: c.get("ip"),
    userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null,
    requestId: c.get("requestId"),
  };
}

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
