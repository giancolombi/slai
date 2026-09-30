/**
 * The Postgres rate-limit store (RATE_LIMIT_STORE=postgres): buckets are shared
 * by every API replica, so two app instances draw from one budget.
 */
import { randomUUID } from "node:crypto";
import { createOrgDb } from "@slai/db";
import { afterAll, describe, expect, it } from "vitest";
import { postgresRateLimiter } from "../src/rate-limit.js";
import { Client, setupApp, urls } from "./harness.js";

describe("shared Postgres rate limiter", () => {
  const a = createOrgDb(urls.app, { max: 1 });
  const b = createOrgDb(urls.app, { max: 1 });
  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  it("two replicas share one bucket", async () => {
    const replicaA = postgresRateLimiter(a.client);
    const replicaB = postgresRateLimiter(b.client);
    const key = `test:${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await (i % 2 ? replicaB : replicaA).take(key, 4, 0));
    expect(results).toEqual([true, true, true, true, false, false]);
  });

  it("refills over time", async () => {
    const limiter = postgresRateLimiter(a.client);
    const key = `test:${randomUUID()}`;
    expect(await limiter.take(key, 1, 20)).toBe(true);
    expect(await limiter.take(key, 1, 20)).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(await limiter.take(key, 1, 20)).toBe(true);
  });
});

describe("shared limit middleware", () => {
  const db = createOrgDb(urls.app, { max: 1 });
  afterAll(() => db.close());
  const inner = postgresRateLimiter(db.client);
  // A tiny budget so the test is quick: every POST under /auth for this IP draws from it.
  const ctx = setupApp({ sharedRateLimit: { take: (key) => inner.take(key, 2, 0) } });

  it("returns 429 once the shared budget for an IP is spent", async () => {
    const client = new Client(ctx, `198.51.100.${Math.floor(Math.random() * 250)}`);
    const body = { email: `nobody-${randomUUID()}@example.com`, password: "wrong password here" };
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await client.post("/auth/sign-in/email", body)).status);
    expect(statuses.slice(0, 2)).not.toContain(429);
    expect(statuses[2]).toBe(429);
  });
});
