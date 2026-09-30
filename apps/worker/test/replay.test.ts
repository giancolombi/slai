import { replays, tickets } from "@slai/db";
import { parsePolicy, type TicketEvent } from "@slai/sla-engine";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { median, warningLeadMs } from "../src/lead.js";
import type { ReplayResult } from "../src/replay.js";
import {
  createConnection,
  createCustomer,
  createOrg,
  createPolicy,
  parkTimers,
  setupWorker,
  TEST_POLICY,
} from "./harness.js";

const h = setupWorker();
const { owner } = h;
let orgId: string;

beforeAll(async () => {
  orgId = await createOrg(owner);
  await createPolicy(owner, orgId);
});
afterAll(() => parkTimers(owner, orgId));

describe("warning lead", () => {
  const policy = parsePolicy({ ...TEST_POLICY, id: "p" });
  const t0 = new Date("2026-09-29T10:00:00Z");
  const min = (m: number) => new Date(t0.getTime() + m * 60_000);

  it("is breachAt minus the first at-risk instant (80% of a 120-minute target = 24 minutes)", () => {
    const events: TicketEvent[] = [
      { type: "created", at: t0, priority: "normal", status: "new" },
      { type: "comment", at: min(200), author: "agent", public: true },
    ];
    const cycle = {
      startedAt: t0,
      stoppedAt: min(200),
      elapsedMs: 200 * 60_000,
      targetMs: 120 * 60_000,
      state: "breached" as const,
      breachAt: min(120),
    };
    expect(warningLeadMs(policy, events, "first_response", cycle)).toBe(24 * 60_000);
    expect(warningLeadMs(policy, events, "first_response", { ...cycle, state: "achieved" })).toBeNull();
  });

  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("run-replay", () => {
  it("replays a connection's history into breaches, attainment, exposure and lead time", async () => {
    const connectionId = await createConnection(h, orgId, {
      config: { seed: "replay", ticketsPerDay: 12, historyDays: 30 },
    });
    // Two of the demo help desk's customer orgs, with fees for exposure.
    await createCustomer(owner, orgId, { name: "Northwind", domains: ["northwind-analytics.example"], fee: 1_000_000 });
    await createCustomer(owner, orgId, { name: "Bluepeak", domains: ["bluepeak.example"], fee: 400_000 });
    const [r] = await owner.db.insert(replays).values({ orgId, connectionId, days: 21 }).returning();
    await h.queue.send("run-replay", { orgId, replayId: r!.id });
    await h.drain();

    const [done] = await owner.db.select().from(replays).where(eq(replays.id, r!.id));
    expect(done!.error).toBeNull();
    expect(done!.status).toBe("succeeded");
    const res = done!.result as ReplayResult;
    expect(done!.progress.ticketsTotal).toBeGreaterThan(100);
    expect(done!.progress.ticketsScanned).toBe(done!.progress.ticketsTotal);
    expect(res.tickets).toBe(done!.progress.ticketsTotal);
    expect(res.breaches).toBeGreaterThan(0);
    expect(res.attainmentPercent).toBeGreaterThan(50);
    expect(res.attainmentPercent).toBeLessThan(100);

    expect(res.byMetric.map((m) => m.metric)).toEqual([
      "first_response",
      "next_response",
      "periodic_update",
      "resolution",
    ]);
    expect(res.byMetric.reduce((n, m) => n + m.breaches, 0)).toBe(res.breaches);
    // TEST_POLICY targets first response and resolution only.
    expect(res.byMetric.find((m) => m.metric === "next_response")!.measured).toBe(0);

    expect(res.byCustomer.reduce((n, c) => n + c.breaches, 0)).toBe(res.breaches);
    expect(res.byCustomer.reduce((n, c) => n + c.exposureCents, 0)).toBe(res.exposureCents);
    const northwind = res.byCustomer.find((c) => c.name === "Northwind")!;
    expect(northwind.breaches).toBeGreaterThan(0);
    expect(northwind.exposureCents).toBeGreaterThan(0);
    // Unmatched tickets have no fee, and the only clause is a percent of the fee.
    expect(res.byCustomer.find((c) => c.customerId === null)?.exposureCents ?? 0).toBe(0);

    // Leads: 20% of 120 minutes for first response, 20% of 5 days for resolution, less for pauses.
    expect(res.medianLeadMinutes).not.toBeNull();
    expect(res.medianLeadMinutes!).toBeGreaterThan(0);
    expect(res.medianLeadMinutes!).toBeLessThanOrEqual(24 * 60);

    // The replayed tickets are in the product right away.
    const [n] = await owner.db.select({ n: count() }).from(tickets).where(eq(tickets.connectionId, connectionId));
    expect(n!.n).toBe(res.tickets);
  });
});
