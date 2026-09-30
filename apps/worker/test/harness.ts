import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime } from "@slai/agents";
import { getConnector } from "@slai/connectors";
import {
  AAD,
  autonomyRules,
  connect,
  connections,
  createKeyring,
  createLocalStorage,
  createOrgDb,
  createSystemDb,
  customerAccounts,
  encrypt,
  encryptJson,
  type JobName,
  type JobPayload,
  notificationChannels,
  organizations,
  slaPolicies,
  testDbUrls,
  tickets,
} from "@slai/db";
import { type PolicyInput, parsePolicy } from "@slai/sla-engine";
import { eq } from "drizzle-orm";
import { afterAll } from "vitest";
import type { Clock } from "../src/clock.js";
import { DEFAULT_CONFIG, noResources, type WorkerDeps } from "../src/deps.js";
import { createHandlers, handleJob } from "../src/handlers.js";
import { createLogger } from "../src/logger.js";
import type { JobQueue, SendOptions } from "../src/queue.js";

export const urls = testDbUrls("slai_test_worker");

export class TestClock implements Clock {
  constructor(public t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(d: Date) {
    this.t = new Date(d);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

interface Queued {
  name: JobName;
  payload: unknown;
  opts: SendOptions;
}

export class MemoryQueue implements JobQueue {
  jobs: Queued[] = [];
  sent: Queued[] = [];
  constructor(private clock: Clock) {}
  async send<N extends JobName>(name: N, payload: JobPayload<N>, opts: SendOptions = {}) {
    const { tx: _tx, ...rest } = opts;
    const job = { name, payload, opts: rest };
    this.jobs.push(job);
    this.sent.push(job);
  }
  count(name: JobName) {
    return this.jobs.filter((j) => j.name === name).length;
  }
  /** Runs queued jobs (and the jobs they enqueue) until nothing runnable is left. */
  async drain(deps: WorkerDeps, only?: JobName[]) {
    const handlers = createHandlers(deps);
    for (let i = 0; i < 100_000; i++) {
      const now = this.clock.now().getTime();
      const idx = this.jobs.findIndex(
        (j) => (!only || only.includes(j.name)) && (!j.opts.startAfter || j.opts.startAfter.getTime() <= now),
      );
      if (idx < 0) return;
      const [job] = this.jobs.splice(idx, 1);
      await handleJob(deps, handlers, job!.name, job!.payload);
    }
    throw new Error("queue did not drain");
  }
}

export interface Outbox {
  mail: { to: string; subject: string; text: string }[];
  slack: { url: string; body: string }[];
}

/** Worker deps against the test database with a test clock, an in-memory queue, and fake outbound I/O. */
export function setupWorker(overrides: Partial<WorkerDeps> = {}, start = new Date("2026-09-29T14:00:00Z")) {
  const keyring = createKeyring({ key: randomBytes(32).toString("base64"), keyId: "k1" });
  const orgDb = createOrgDb(urls.app, { max: 4 });
  const systemDb = createSystemDb(urls.system, { max: 2 });
  const owner = connect(urls.owner, { max: 2 });
  const clock = new TestClock(start);
  const queue = new MemoryQueue(clock);
  const outbox: Outbox = { mail: [], slack: [] };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    outbox.slack.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const deps: WorkerDeps = {
    orgDb,
    systemDb,
    queue,
    clock,
    keyring,
    connectors: { get: getConnector },
    fetch: fakeFetch,
    agents: createAgentRuntime({ runtime: "local", provider: "mock" }),
    mailer: {
      async send(m) {
        outbox.mail.push(m);
      },
    },
    storage: createLocalStorage(join(tmpdir(), "slai-worker-test-uploads")),
    logger: createLogger("silent"),
    resources: noResources,
    config: { ...DEFAULT_CONFIG },
    ...overrides,
  };
  afterAll(async () => {
    await Promise.all([orgDb.close(), systemDb.close(), owner.close()]);
  });
  return { deps, owner, clock, queue, outbox, keyring, drain: (only?: JobName[]) => queue.drain(deps, only) };
}

export type Harness = ReturnType<typeof setupWorker>;
type Owner = Harness["owner"];

export async function tmpStorageDir() {
  return mkdtemp(join(tmpdir(), "slai-worker-"));
}

// ---------- fixtures (written as the owner role) ----------

/** An org on an active Scale plan by default (every agent level allowed); pass `billing` to test plans (T-65). */
export async function createOrg(
  owner: Owner,
  opts: { capCents?: number | null; billing?: Partial<typeof organizations.$inferInsert> } = {},
) {
  const id = randomUUID();
  await owner.db.insert(organizations).values({
    id,
    name: `Org ${id.slice(0, 8)}`,
    slug: `org-${id}`,
    monthlySpendCapCents: opts.capCents ?? null,
    plan: "scale",
    billingStatus: "active",
    trialEndsAt: null,
    ...opts.billing,
  });
  return id;
}

export async function createConnection(
  h: Harness,
  orgId: string,
  opts: { provider?: string; config?: Record<string, unknown>; credentials?: Record<string, unknown> } = {},
) {
  const id = randomUUID();
  await h.owner.db.insert(connections).values({
    id,
    orgId,
    provider: opts.provider ?? "demo",
    name: "Test connection",
    credentials: encryptJson(opts.credentials ?? {}, { keyring: h.keyring, aad: AAD.connectionCredentials(id) }),
    config: opts.config ?? {},
  });
  return id;
}

export const TEST_POLICY: Omit<PolicyInput, "id"> = {
  name: "Test 24x7",
  calendar: {
    timezone: "UTC",
    weekly: Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ start: "00:00", end: "24:00" }]]),
    ),
    holidays: [],
  },
  defaultPriority: "normal",
  targets: (["urgent", "high", "normal", "low"] as const).flatMap((priority) => [
    { metric: "first_response" as const, priority, minutes: 120, clock: "calendar" as const },
    { metric: "resolution" as const, priority, minutes: 60 * 24 * 5, clock: "calendar" as const },
  ]),
  pauseStatuses: { resolution: ["pending", "on_hold"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [
    {
      id: "per-breach",
      basis: "per_breach",
      metric: "first_response",
      priority: null,
      amount: { kind: "percent_of_fee", percent: 2 },
      capPercent: 20,
      sourceClause: "2% per missed first response, capped at 20%.",
    },
  ],
};

export async function createPolicy(owner: Owner, orgId: string, def = TEST_POLICY, isDefault = true) {
  const id = randomUUID();
  await owner.db.insert(slaPolicies).values({
    id,
    orgId,
    lineageId: id,
    name: def.name,
    status: "active",
    isDefault,
    definition: parsePolicy({ ...def, id }),
  });
  return id;
}

export async function createCustomer(
  owner: Owner,
  orgId: string,
  c: { name: string; domains: string[]; fee?: number | null; policyId?: string | null },
) {
  const [row] = await owner.db
    .insert(customerAccounts)
    .values({ orgId, name: c.name, domains: c.domains, monthlyFeeCents: c.fee ?? null, policyId: c.policyId ?? null })
    .returning({ id: customerAccounts.id });
  return row!.id;
}

export async function createRule(
  owner: Owner,
  orgId: string,
  r: {
    customerAccountId: string | null;
    level: "observe" | "assist" | "autopilot";
    triggerAt?: "warning" | "at_risk" | "breached";
  },
) {
  await owner.db.insert(autonomyRules).values({
    orgId,
    customerAccountId: r.customerAccountId,
    level: r.level,
    triggerAt: r.triggerAt ?? "at_risk",
    minConfidence: 0.8,
  });
}

export async function createChannel(
  h: Harness,
  orgId: string,
  c: { kind: "email" | "slack_webhook"; target: string; minRisk?: "warning" | "at_risk" | "breached" },
) {
  const id = randomUUID();
  await h.owner.db.insert(notificationChannels).values({
    id,
    orgId,
    kind: c.kind,
    target:
      c.kind === "slack_webhook"
        ? encrypt(c.target, { keyring: h.keyring, aad: AAD.notificationTarget(id) })
        : c.target,
    minRisk: c.minRisk ?? "at_risk",
  });
  return id;
}

/** Stops this org's tickets from being claimed by later sweeps (files share the database). */
export async function parkTimers(owner: Owner, orgId: string) {
  await owner.db.update(tickets).set({ nextCheckAt: null }).where(eq(tickets.orgId, orgId));
}
