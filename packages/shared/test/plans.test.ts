import { describe, expect, it } from "vitest";
import {
  billingPeriod,
  creditBalance,
  cycleLiveIn,
  entitlements,
  mapStripeStatus,
  minCeiling,
  PAST_DUE_GRACE_DAYS,
  PLANS,
  TRIAL,
  trackedOverage,
} from "../src/plans.js";

const DAY = 86_400_000;
const now = new Date("2026-09-15T12:00:00Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

describe("plans", () => {
  it("encodes the pricing in specs/product.md §4", () => {
    expect([PLANS.starter.priceCents, PLANS.growth.priceCents, PLANS.scale.priceCents]).toEqual([
      29_900, 99_900, 249_900,
    ]);
    expect([PLANS.starter.trackedTickets, PLANS.growth.trackedTickets, PLANS.scale.trackedTickets]).toEqual([
      1_500, 7_500, 25_000,
    ]);
    expect([PLANS.starter.ceiling, PLANS.growth.ceiling, PLANS.scale.ceiling]).toEqual([
      "triage",
      "assist",
      "autopilot",
    ]);
    expect(PLANS.replay.ceiling).toBe("observe");
  });

  it("minCeiling picks the lower level", () => {
    expect(minCeiling("autopilot", "assist")).toBe("assist");
    expect(minCeiling("triage", "assist")).toBe("triage");
    expect(minCeiling("observe", "autopilot")).toBe("observe");
  });
});

describe("entitlements", () => {
  const facts = { plan: "growth", status: "trialing" as const, trialEndsAt: at(10), pastDueSince: null };

  it("a trial runs Growth without autopilot, with the trial allowance and no overage", () => {
    const e = entitlements({ ...facts, plan: "scale" }, now);
    expect(e.state).toBe("trialing");
    expect(e.ceiling).toBe("assist");
    expect(e.includedCredits).toBe(TRIAL.includedCredits);
    expect(e.overageBilled).toBe(false);
    expect(e.trialDaysLeft).toBe(10);
  });

  it("at trial expiry with no subscription, agents drop to observe", () => {
    const e = entitlements({ ...facts, trialEndsAt: at(-0.001) }, now);
    expect(e.state).toBe("trial_expired");
    expect(e.ceiling).toBe("observe");
    expect(e.includedCredits).toBe(0);
    expect(entitlements({ ...facts, trialEndsAt: null }, now).state).toBe("trial_expired");
  });

  it("an active plan gets its own ceiling and credits", () => {
    const e = entitlements({ ...facts, plan: "starter", status: "active", trialEndsAt: null }, now);
    expect(e).toMatchObject({ state: "active", ceiling: "triage", includedCredits: 5_000, overageBilled: true });
  });

  it("past due keeps the plan through the grace period, then degrades to observe", () => {
    const pd = { plan: "scale", status: "past_due" as const, trialEndsAt: null };
    const inGrace = entitlements({ ...pd, pastDueSince: at(-(PAST_DUE_GRACE_DAYS - 1)) }, now);
    expect(inGrace).toMatchObject({ state: "past_due", ceiling: "autopilot" });
    expect(inGrace.graceEndsAt).toEqual(at(1));
    const after = entitlements({ ...pd, pastDueSince: at(-PAST_DUE_GRACE_DAYS) }, now);
    expect(after).toMatchObject({ state: "degraded", ceiling: "observe" });
  });

  it("canceled is observe only", () => {
    const e = entitlements({ plan: "scale", status: "canceled", trialEndsAt: null, pastDueSince: null }, now);
    expect(e).toMatchObject({ state: "canceled", ceiling: "observe", includedCredits: 0 });
  });

  it("an unknown stored plan falls back to Growth", () => {
    expect(entitlements({ ...facts, plan: "trial" }, now).plan.id).toBe("growth");
  });
});

describe("creditBalance", () => {
  const base = { included: 20_000, purchasedAvailable: 0, capOverrideCents: null, overageAllowed: true };

  it("draws included first, then purchased, then overage", () => {
    expect(creditBalance({ ...base, used: 5_000, purchasedAvailable: 10_000 })).toMatchObject({
      fromIncluded: 5_000,
      fromPurchased: 0,
      overage: 0,
    });
    expect(creditBalance({ ...base, used: 25_000, purchasedAvailable: 10_000 })).toMatchObject({
      fromIncluded: 20_000,
      fromPurchased: 5_000,
      overage: 0,
    });
    expect(creditBalance({ ...base, used: 33_000, purchasedAvailable: 10_000 })).toMatchObject({
      fromIncluded: 20_000,
      fromPurchased: 10_000,
      overage: 3_000,
    });
  });

  it("the default cap is included + purchased + 50% of included", () => {
    const b = creditBalance({ ...base, used: 0, purchasedAvailable: 10_000 });
    expect(b.cap).toBe(40_000);
    expect(creditBalance({ ...base, used: 39_999, purchasedAvailable: 10_000 }).overCap).toBe(false);
    const over = creditBalance({ ...base, used: 40_000, purchasedAvailable: 10_000 });
    expect(over.overCap).toBe(true);
    expect(over.remaining).toBe(0);
  });

  it("an owner override replaces the default cap", () => {
    expect(creditBalance({ ...base, used: 100, capOverrideCents: 100 }).overCap).toBe(true);
    expect(creditBalance({ ...base, used: 0, capOverrideCents: 50_000 }).cap).toBe(50_000);
  });

  it("without overage (trial), the cap never exceeds included + purchased", () => {
    const trial = { ...base, included: 5_000, overageAllowed: false };
    expect(creditBalance({ ...trial, used: 0 }).cap).toBe(5_000);
    expect(creditBalance({ ...trial, used: 0, capOverrideCents: 99_999 }).cap).toBe(5_000);
    expect(creditBalance({ ...trial, used: 0, purchasedAvailable: 10_000 }).cap).toBe(15_000);
  });

  it("nothing included and nothing bought is over the cap at once", () => {
    expect(creditBalance({ ...base, included: 0, overageAllowed: false, used: 0 }).overCap).toBe(true);
  });
});

describe("tracked tickets", () => {
  const period = billingPeriod(now);

  it("the period is the UTC calendar month", () => {
    expect(period.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a cycle counts if it was live at any point in the period", () => {
    const d = (s: string) => new Date(s);
    // Running (not stopped), started last month.
    expect(cycleLiveIn({ startedAt: d("2026-08-20T00:00:00Z"), stoppedAt: null }, period)).toBe(true);
    // Stopped inside the period.
    expect(cycleLiveIn({ startedAt: d("2026-08-31T00:00:00Z"), stoppedAt: d("2026-09-01T00:00:00Z") }, period)).toBe(
      true,
    );
    // Stopped before the period.
    expect(cycleLiveIn({ startedAt: d("2026-08-01T00:00:00Z"), stoppedAt: d("2026-08-31T23:59:59Z") }, period)).toBe(
      false,
    );
    // Starts after the period.
    expect(cycleLiveIn({ startedAt: d("2026-10-01T00:00:00Z"), stoppedAt: null }, period)).toBe(false);
  });

  it("overage is tickets past the limit; no limit means no overage", () => {
    expect(trackedOverage(1_600, 1_500)).toBe(100);
    expect(trackedOverage(1_000, 1_500)).toBe(0);
    expect(trackedOverage(1_000_000, null)).toBe(0);
  });
});

describe("mapStripeStatus", () => {
  it("maps every Stripe subscription status", () => {
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("trialing")).toBe("active");
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("unpaid")).toBe("past_due");
    expect(mapStripeStatus("incomplete")).toBe("past_due");
    expect(mapStripeStatus("canceled")).toBe("canceled");
    expect(mapStripeStatus("incomplete_expired")).toBe("canceled");
    expect(mapStripeStatus("paused")).toBe("canceled");
  });
});
