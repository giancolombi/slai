import { billingPeriod } from "@slai/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { countTrackedTickets, loadOrgBilling, periodUsage, purchasedCreditsAvailable } from "../src/billing.js";
import { billingPeriods, creditGrants, organizations, slaOutcomes, usageLedger } from "../src/schema.js";
import { failure, openDbs, seedOrg } from "./helpers.js";

const { owner, app } = openDbs();
const d = (s: string) => new Date(s);
const september = billingPeriod(d("2026-09-15T00:00:00Z"));

async function cycle(orgId: string, ticketId: string, i: number, startedAt: string, stoppedAt: string | null) {
  await owner.db.insert(slaOutcomes).values({
    orgId,
    ticketId,
    metric: "resolution",
    cycleIndex: i,
    state: stoppedAt ? "achieved" : "running",
    startedAt: d(startedAt),
    stoppedAt: stoppedAt ? d(stoppedAt) : null,
    targetMs: 3_600_000,
    elapsedMs: 0,
  });
}

describe("new organizations", () => {
  it("start on the 14-day Growth trial, whatever creates the row", async () => {
    const { orgId } = await seedOrg(owner, 0);
    const [o] = await owner.db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(o).toMatchObject({ plan: "growth", billingStatus: "trialing" });
    const days = (o!.trialEndsAt!.getTime() - o!.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(14, 3);
  });
});

describe("tracked tickets", () => {
  it("counts each ticket with any SLA cycle live during the period, once", async () => {
    const { orgId, ticketIds } = await seedOrg(owner, 5);
    const [a, b, c, e, f] = ticketIds as [string, string, string, string, string];
    await cycle(orgId, a, 0, "2026-08-20T00:00:00Z", null); // running since August
    await cycle(orgId, a, 1, "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"); // same ticket again
    await cycle(orgId, b, 0, "2026-08-30T00:00:00Z", "2026-09-01T00:00:00Z"); // stopped at the boundary
    await cycle(orgId, c, 0, "2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z"); // August only
    await cycle(orgId, e, 0, "2026-10-01T00:00:00Z", null); // October only
    void f; // no SLA at all
    const n = await app.withOrg(orgId, (tx) => countTrackedTickets(tx, september));
    expect(n).toBe(2);
    // Another org sees none of them (RLS).
    const other = await seedOrg(owner, 0);
    expect(await app.withOrg(other.orgId, (tx) => countTrackedTickets(tx, september))).toBe(0);
  });
});

describe("credits", () => {
  it("purchased credits carry over, minus what earlier periods drew", async () => {
    const { orgId } = await seedOrg(owner, 0);
    await owner.db.insert(creditGrants).values([
      { orgId, credits: 10_000, source: "credit_pack", createdAt: d("2026-08-10T00:00:00Z") },
      { orgId, credits: 5_000, source: "manual", createdAt: d("2026-09-10T00:00:00Z") },
      { orgId, credits: 7_000, source: "manual", createdAt: d("2026-10-02T00:00:00Z") },
    ]);
    await owner.db.insert(billingPeriods).values({
      orgId,
      periodStart: d("2026-08-01T00:00:00Z"),
      periodEnd: d("2026-09-01T00:00:00Z"),
      plan: "growth",
      purchasedCreditsUsed: 4_000,
    });
    expect(await app.withOrg(orgId, (tx) => purchasedCreditsAvailable(tx, september))).toBe(11_000);
  });

  it("period usage combines the plan, the ledger and the grants", async () => {
    const { orgId } = await seedOrg(owner, 0);
    await owner.db
      .update(organizations)
      .set({ plan: "starter", billingStatus: "active", trialEndsAt: null })
      .where(eq(organizations.id, orgId));
    await owner.db
      .insert(creditGrants)
      .values({ orgId, credits: 1_000, source: "manual", createdAt: d("2026-09-01T00:00:00Z") });
    await owner.db.insert(usageLedger).values({
      orgId,
      kind: "model_call",
      quantity: 1,
      unit: "tokens",
      credits: 6_500,
      createdAt: d("2026-09-10T00:00:00Z"),
    });
    const u = await app.withOrg(orgId, async (tx) =>
      periodUsage(tx, (await loadOrgBilling(tx))!, d("2026-09-15T00:00:00Z")),
    );
    expect(u.balance).toMatchObject({ fromIncluded: 5_000, fromPurchased: 1_000, overage: 500, cap: 8_500 });
    expect(u.creditOverageCents).toBe(500);
    expect(u.trackedLimit).toBe(1_500);
  });

  it("credit grants are append-only", async () => {
    const { orgId } = await seedOrg(owner, 0);
    await owner.db.insert(creditGrants).values({ orgId, credits: 1, source: "manual" });
    expect(
      await failure(owner.db.update(creditGrants).set({ credits: 2 }).where(eq(creditGrants.orgId, orgId))),
    ).toMatch(/append-only/);
    expect(
      await failure(app.withOrg(orgId, (tx) => tx.delete(creditGrants).where(eq(creditGrants.orgId, orgId)))),
    ).toMatch(/permission denied|append-only/);
  });
});
