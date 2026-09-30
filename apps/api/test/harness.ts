// biome-ignore-all lint/suspicious/noExplicitAny: test client bodies are asserted loosely
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connect,
  createJobSender,
  createKeyring,
  createLocalStorage,
  createOrgDb,
  createProducerBoss,
  createSystemDb,
  memberships,
  testDbUrls,
} from "@slai/db";
import type { Me, Role } from "@slai/shared";
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

export function testEnv(): Env {
  return {
    NODE_ENV: "test",
    PORT: 0,
    LOG_LEVEL: "silent",
    APP_URL,
    API_URL,
    DATABASE_APP_URL: urls.app,
    DATABASE_SYSTEM_URL: urls.system,
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY_ID: "k1",
    ENCRYPTION_KEYS_PREVIOUS: undefined,
    SESSION_SECRET: randomBytes(32).toString("base64"),
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: "",
    TRUST_PROXY: true,
  };
}

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
export function setupApp(overrides: Partial<AppDeps> = {}) {
  const env = testEnv();
  const orgDb = createOrgDb(urls.app, { max: 4 });
  const systemDb = createSystemDb(urls.system, { max: 4 });
  const owner = connect(urls.owner, { max: 2 });
  const boss = createProducerBoss(urls.app);
  boss.on("error", () => {});
  const clock = { now: new Date() as Date | null };
  const deps: AppDeps = {
    env,
    orgDb,
    systemDb,
    jobs: createJobSender(boss),
    storage: createLocalStorage(join(tmpdir(), "slai-test-uploads")),
    connectors: fakeRegistry(),
    fetch: (() => Promise.reject(new Error("no network in tests"))) as typeof fetch,
    keyring: createKeyring({ key: env.ENCRYPTION_KEY, keyId: "k1" }),
    logger: createLogger("silent"),
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
    await Promise.all([orgDb.close(), systemDb.close(), owner.close()]);
  });
  return ctx;
}

export type TestCtx = ReturnType<typeof setupApp>;

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A browser-like client: keeps the session cookie and sends the CSRF header. */
export class Client {
  cookie: string | null = null;
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
    if (this.cookie) headers.cookie = this.cookie;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const res = await this.ctx.app.request(`/api/v1${path}`, { method, headers, body });
    const set = res.headers.get("set-cookie");
    if (set) {
      const m = /slai_session=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `slai_session=${m[1]}` : null;
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
  get = <T = any>(p: string, o?: Parameters<Client["req"]>[2]) => this.req<T>("GET", p, o);
  post = <T = any>(p: string, json?: unknown, o?: Parameters<Client["req"]>[2]) =>
    this.req<T>("POST", p, { ...o, json });
  patch = <T = any>(p: string, json?: unknown) => this.req<T>("PATCH", p, { json });
  put = <T = any>(p: string, json?: unknown) => this.req<T>("PUT", p, { json });
  del = <T = any>(p: string) => this.req<T>("DELETE", p);
}

export const PASSWORD = "correct horse battery staple";

/** Signs up a fresh user + org; returns the signed-in client and Me. */
export async function signup(ctx: TestCtx, name = "Ada") {
  const client = new Client(ctx);
  const email = `${name.toLowerCase()}-${randomUUID()}@example.com`;
  const res = await client.post<Me>("/auth/signup", {
    email,
    password: PASSWORD,
    name,
    organizationName: `${name} Inc`,
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, email, me: res.body, orgId: res.body.organization.id, userId: res.body.user.id };
}

/** Adds a new user with `role` to `orgId` (direct DB fixture) and signs them in. */
export async function addMember(ctx: TestCtx, orgId: string, role: Role) {
  const { client, userId, email } = await signup(ctx, role);
  await ctx.owner.db.insert(memberships).values({ orgId, userId, role });
  const res = await client.post("/auth/switch-org", { organizationId: orgId });
  if (res.status !== 200) throw new Error(`switch failed ${res.status}`);
  return { client, userId, email };
}
