// biome-ignore-all lint/suspicious/noExplicitAny: test client bodies are asserted loosely
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connect,
  createAuthDb,
  createJobSender,
  createKeyring,
  createLocalStorage,
  createOrgDb,
  createProducerBoss,
  createSystemDb,
  memberships,
  testDbUrls,
  totp,
} from "@slai/db";
import type { Me, Role, SignInResult, TotpEnrollment } from "@slai/shared";
import { afterAll, beforeAll } from "vitest";
import { createApp } from "../src/app.js";
import type { AnyConnector, AppDeps, ConnectorRegistry } from "../src/context.js";
import type { Env } from "../src/env.js";
import { createEventHub } from "../src/events-hub.js";
import { createLogger } from "../src/logger.js";
import { defaultRateLimits } from "../src/rate-limit.js";

export const urls = testDbUrls("slai_test_api");
export const APP_URL = "http://localhost:5173";
export const API_URL = "http://localhost:8787";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 0,
    LOG_LEVEL: "silent",
    APP_URL,
    API_URL,
    DATABASE_APP_URL: urls.app,
    DATABASE_SYSTEM_URL: urls.system,
    DATABASE_AUTH_URL: urls.auth,
    DB_POOL_APP: 4,
    DB_POOL_SYSTEM: 4,
    DB_POOL_AUTH: 4,
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY_ID: "k1",
    ENCRYPTION_KEYS_PREVIOUS: undefined,
    SESSION_SECRET: randomBytes(32).toString("base64"),
    SESSION_SECRET_VERSION: 1,
    SESSION_SECRETS_PREVIOUS: undefined,
    SSO_TRUSTED_IDP_ORIGINS: [],
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: "",
    TRUST_PROXY: true,
    RATE_LIMIT_STORE: "memory",
    ...overrides,
  };
}

/** Fake DNS for SSO domain verification: tests publish TXT records here. */
export const dnsTxt = new Map<string, string[][]>();

export function fakeRegistry(defs: AnyConnector[] = []): ConnectorRegistry {
  return {
    get: (p) => defs.find((d) => d.provider === p) ?? null,
    list: () => defs,
  };
}

/**
 * Boots the app against the test database for one test file. Every file gets
 * its own orgs (unique emails), so files run in parallel without truncating.
 */
export function setupApp(overrides: Partial<AppDeps> = {}, envOverrides: Partial<Env> = {}) {
  const env = testEnv(envOverrides);
  const orgDb = createOrgDb(urls.app, { max: 4 });
  const systemDb = createSystemDb(urls.system, { max: 4 });
  const authDb = createAuthDb(urls.auth, { max: 4 });
  const owner = connect(urls.owner, { max: 2 });
  const boss = createProducerBoss(urls.app);
  boss.on("error", () => {});
  const clock = { now: new Date() as Date | null };
  const deps: AppDeps = {
    env,
    orgDb,
    systemDb,
    authDb,
    resolveTxt: async (host) => {
      const r = dnsTxt.get(host);
      if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return r;
    },
    jobs: createJobSender(boss),
    storage: createLocalStorage(join(tmpdir(), "slai-test-uploads")),
    connectors: fakeRegistry(),
    fetch: (() => Promise.reject(new Error("no network in tests"))) as typeof fetch,
    keyring: createKeyring({ key: env.ENCRYPTION_KEY, keyId: "k1" }),
    // TEST_LOG_LEVEL=error surfaces server errors behind a 500 when debugging a failing test.
    logger: createLogger((process.env.TEST_LOG_LEVEL as "silent" | "error" | undefined) ?? "silent"),
    rateLimits: defaultRateLimits(),
    events: createEventHub(systemDb.client),
    now: () => clock.now ?? new Date(),
    ready: async () => {
      await systemDb.client`select 1`;
      return true;
    },
    ...overrides,
  };
  const ctx = { app: createApp(deps), deps, owner, clock };
  beforeAll(async () => {
    await boss.start();
    deps.storage = overrides.storage ?? createLocalStorage(await mkdtemp(join(tmpdir(), "slai-uploads-")));
  });
  afterAll(async () => {
    await deps.events.close();
    await boss.stop({ graceful: false });
    await Promise.all([orgDb.close(), systemDb.close(), authDb.close(), owner.close()]);
  });
  return ctx;
}

export type TestCtx = ReturnType<typeof setupApp>;

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A browser-like client: keeps its cookies (a jar) and sends the CSRF header. */
export class Client {
  readonly jar = new Map<string, string>();
  /** The session cookie as a Cookie header value (or null), for replay tests. */
  get cookie(): string | null {
    const v = this.jar.get("slai_session");
    return v ? `slai_session=${v}` : null;
  }
  set cookie(value: string | null) {
    this.jar.delete("slai_session");
    const m = value ? /^slai_session=(.+)$/.exec(value) : null;
    if (m?.[1]) this.jar.set("slai_session", m[1]);
  }
  constructor(
    private readonly ctx: TestCtx,
    readonly ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  ) {}

  async req<T = any>(
    method: string,
    path: string,
    opts: { json?: unknown; body?: RequestInit["body"]; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { "x-forwarded-for": this.ip, origin: APP_URL, ...opts.headers };
    if (opts.csrf !== false) headers["x-requested-with"] = "slai";
    if (this.jar.size > 0) {
      headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const url = path.startsWith("http") ? path : `/api/v1${path}`;
    const res = await this.ctx.app.request(url, { method, headers, body, redirect: "manual" });
    this.absorb(res.headers);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
  /** Applies Set-Cookie headers to the jar (a deletion removes the cookie). */
  absorb(h: Headers) {
    for (const line of h.getSetCookie()) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(line);
      if (!m) continue;
      const [, name, value] = m as unknown as [string, string, string];
      if (!value || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  get = <T = any>(p: string, o?: Parameters<Client["req"]>[2]) => this.req<T>("GET", p, o);
  post = <T = any>(p: string, json?: unknown, o?: Parameters<Client["req"]>[2]) =>
    this.req<T>("POST", p, { ...o, json });
  patch = <T = any>(p: string, json?: unknown) => this.req<T>("PATCH", p, { json });
  put = <T = any>(p: string, json?: unknown) => this.req<T>("PUT", p, { json });
  del = <T = any>(p: string) => this.req<T>("DELETE", p);
}

export const PASSWORD = "correct horse battery staple";

/**
 * Signs up a fresh user + org. The session is in enrollment (MFA pending): only
 * /auth routes work until a factor is added.
 */
export async function signupPending(ctx: TestCtx, name = "Ada", email?: string) {
  const client = new Client(ctx);
  email ??= `${name.toLowerCase()}-${randomUUID()}@example.com`;
  const res = await client.post<SignInResult>("/auth/signup", {
    email,
    password: PASSWORD,
    name,
    organizationName: `${name} Inc`,
  });
  if (res.status !== 201 || res.body.status !== "mfa_enrollment_required") {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const me = res.body.me;
  return { client, email, me, orgId: me.organization.id, userId: me.user.id };
}

/** Enrolls TOTP for a signed-in client; returns the base32 secret and the backup codes. */
export async function enrollTotp(client: Client, password: string | undefined = PASSWORD) {
  const setup = await client.post<TotpEnrollment>("/auth/two-factor/enable", { password });
  if (setup.status !== 200) throw new Error(`enable failed: ${setup.status} ${JSON.stringify(setup.body)}`);
  const verified = await client.post<SignInResult>("/auth/two-factor/verify-totp", { code: totp(setup.body.secret) });
  if (verified.status !== 200 || verified.body.status !== "signed_in") {
    throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  return { secret: setup.body.secret, backupCodes: setup.body.backupCodes, me: verified.body.me };
}

/** Signs up a fresh user + org and enrolls TOTP, so the session is fully signed in. */
export async function signup(ctx: TestCtx, name = "Ada") {
  const s = await signupPending(ctx, name);
  const { secret, backupCodes, me } = await enrollTotp(s.client);
  return { ...s, me: me as Me, totpSecret: secret, backupCodes };
}

/** A code for the next TOTP step (the current one may already be used: replays are refused). */
export const nextCode = (secret: string, steps = 1) => totp(secret, new Date(Date.now() + steps * 30_000));

/** Adds a new user with `role` to `orgId` (direct DB fixture) and signs them in. */
export async function addMember(ctx: TestCtx, orgId: string, role: Role) {
  const { client, userId, email } = await signup(ctx, role);
  await ctx.owner.db.insert(memberships).values({ orgId, userId, role });
  const res = await client.post("/auth/switch-org", { organizationId: orgId });
  if (res.status !== 200) throw new Error(`switch failed ${res.status}`);
  return { client, userId, email };
}
