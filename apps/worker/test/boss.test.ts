import { randomUUID } from "node:crypto";
import { tickets } from "@slai/db";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { bossQueue } from "../src/queue.js";
import { createConsumerBoss, registerHandlers } from "../src/worker.js";
import { createConnection, createOrg, createPolicy, parkTimers, setupWorker, urls } from "./harness.js";

const h = setupWorker();
const boss = createConsumerBoss(urls.app);
let orgId: string;

beforeAll(async () => {
  boss.on("error", () => {});
  await boss.start();
  h.deps.queue = bossQueue(boss);
  orgId = await createOrg(h.owner);
  await createPolicy(h.owner, orgId);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await parkTimers(h.owner, orgId);
});

describe("pg-boss wiring", () => {
  it("processes a sync end to end through real queues (app role)", async () => {
    await registerHandlers(boss, h.deps, 4);
    const connectionId = await createConnection(h, orgId, {
      config: { seed: "boss", ticketsPerDay: 4, historyDays: 1 },
    });
    await h.deps.queue.send("sync-connection", { orgId, connectionId, full: true });
    let n = 0;
    for (let i = 0; i < 100 && n < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const [row] = await h.owner.db.select({ n: count() }).from(tickets).where(eq(tickets.orgId, orgId));
      n = row!.n;
    }
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it("deduplicates timer jobs per ticket with a singleton key", async () => {
    const ticketId = randomUUID();
    const key = { singletonKey: ticketId, singletonSeconds: 60 };
    const a = await boss.send("evaluate-ticket", { orgId, ticketId }, key);
    const b = await boss.send("evaluate-ticket", { orgId, ticketId }, key);
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });
});

describe("env", () => {
  const base = {
    DATABASE_APP_URL: "postgres://slai_app:x@localhost:5433/slai",
    DATABASE_SYSTEM_URL: "postgres://slai_worker:x@localhost:5433/slai",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("applies local defaults (mock provider, local runtime, 15s sweep)", () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ MODEL_PROVIDER: "mock", AGENT_RUNTIME: "local", SWEEP_INTERVAL_SECONDS: 15 });
  });

  it("fails fast without echoing secret values", () => {
    expect(() => loadEnv({ ...base, ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/ENCRYPTION_KEY: .*32 bytes/);
    try {
      loadEnv({ ...base, ENCRYPTION_KEY: "c2hvcnQ=" });
    } catch (e) {
      expect(String(e)).not.toContain("c2hvcnQ=");
    }
  });
});
