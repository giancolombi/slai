import type { BillingState } from "@slai/shared";
import { describe, expect, it } from "vitest";
import { bannerKey, billingNotice, creditMeter, fraction, planPrice, shellBanner, usd } from "../src/lib/billing";

const b = (state: BillingState, trialDaysLeft: number | null = null, graceEndsAt: string | null = null) => ({
  state,
  plan: "growth" as const,
  trialDaysLeft,
  graceEndsAt,
});

describe("billingNotice (billing page)", () => {
  it("shows days left and that autopilot is off during a trial", () => {
    const n = billingNotice(b("trialing", 9));
    expect(n?.title).toBe("9 days left in your Growth trial");
    expect(n?.message).toMatch(/autopilot is off/i);
    expect(n?.tone).toBe("accent");
  });
  it("warns in the last 3 days, with a singular day", () => {
    expect(billingNotice(b("trialing", 1))).toMatchObject({
      tone: "warning",
      title: "1 day left in your Growth trial",
    });
  });
  it("says agents are observe-only and monitoring continues once the trial ends", () => {
    const n = billingNotice(b("trial_expired", 0));
    expect(n?.message).toMatch(/observe-only/);
    expect(n?.message).toMatch(/monitoring and alerts continue/);
  });
  it("names the grace end while past due", () => {
    expect(billingNotice(b("past_due", null, "2026-10-07T12:00:00.000Z"))?.message).toMatch(/Oct 7, 2026/);
  });
  it("has nothing to say for an active plan", () => {
    expect(billingNotice(b("active"))).toBeNull();
  });
});

describe("shellBanner (app shell)", () => {
  it("stays quiet early in a trial and appears within the warning window", () => {
    expect(shellBanner(b("trialing", 9))).toBeNull();
    expect(shellBanner(b("trialing", 4))).toBeNull();
    expect(shellBanner(b("trialing", 3))).not.toBeNull();
  });
  it("shows for an ended trial and payment problems, not for active or canceled", () => {
    expect(shellBanner(b("trial_expired", 0))).not.toBeNull();
    expect(shellBanner(b("past_due", null, "2026-10-07T12:00:00.000Z"))).not.toBeNull();
    expect(shellBanner(b("degraded"))).not.toBeNull();
    expect(shellBanner(b("active"))).toBeNull();
    expect(shellBanner(b("canceled"))).toBeNull();
  });
  it("re-shows a dismissed banner when the day count changes", () => {
    expect(bannerKey(b("trialing", 3))).not.toBe(bannerKey(b("trialing", 2)));
  });
});

describe("formatting and meters", () => {
  it("prices plans in plain words", () => {
    expect(planPrice("growth")).toBe("$999/mo");
    expect(planPrice("enterprise")).toBe("Custom");
    expect(planPrice("replay")).toBe("Free");
    expect(usd(20)).toBe("$0.20");
  });
  it("computes meter fractions without dividing by zero", () => {
    expect(fraction(3_750, 7_500)).toBe(0.5);
    expect(fraction(9_000, 7_500)).toBe(1.2);
    expect(fraction(10, null)).toBe(0);
    expect(fraction(10, 0)).toBe(0);
  });
});

describe("creditMeter", () => {
  const credits = (used: number, included: number, purchasedAvailable: number, cap: number) => ({
    used,
    included,
    purchasedAvailable,
    cap,
  });
  it("fills to the default cap (prepaid + 50% of included) and warns once into overage", () => {
    const m = creditMeter(credits(12_000, 20_000, 0, 30_000));
    expect(m.scale).toBe(30_000);
    expect(m.capAt).toBe(1);
    expect(m.warnAt).toBeCloseTo(2 / 3, 5);
    expect(m.overCap).toBe(false);
  });
  it("marks a cap set below prepaid credits and flags usage at the cap", () => {
    const m = creditMeter(credits(10_000, 20_000, 10_000, 10_000));
    expect(m.scale).toBe(30_000);
    expect(m.capAt).toBeCloseTo(1 / 3, 5);
    expect(m.overCap).toBe(true);
  });
  it("warns at 80% of the cap in a trial (cap = included)", () => {
    expect(creditMeter(credits(3_792, 5_000, 0, 5_000)).warnAt).toBe(0.8);
  });
});
