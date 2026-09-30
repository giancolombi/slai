import { describe, expect, it } from "vitest";
import { computeAttainment, computeCredits, evaluateTicket, parsePolicy } from "../src/index.js";
import { agentReply, at, created, policy } from "./fixtures.js";

const now = at("2026-10-31T00:00:00Z");
const evals = [
  // urgent first response: 30 min (met), 90 min (breach), 120 min (breach), 10 min (met)
  [created("2026-10-05T13:00:00Z", "urgent"), agentReply("2026-10-05T13:30:00Z")],
  [created("2026-10-06T13:00:00Z", "urgent"), agentReply("2026-10-06T14:30:00Z")],
  [created("2026-10-07T13:00:00Z", "urgent"), agentReply("2026-10-07T15:00:00Z")],
  [created("2026-10-08T13:00:00Z", "urgent"), agentReply("2026-10-08T13:10:00Z")],
].map((events) => evaluateTicket(policy(), events, now));

describe("computeAttainment", () => {
  it("counts final outcomes for a metric", () => {
    expect(computeAttainment(evals, { metric: "first_response", priority: "urgent" })).toEqual({
      measured: 4,
      met: 2,
      breached: 2,
      percent: 50,
    });
  });
});

describe("computeCredits", () => {
  it("applies per-breach credits up to the cap", () => {
    const { totalCents, lines } = computeCredits(
      [
        {
          id: "c1",
          basis: "per_breach",
          metric: "first_response",
          priority: "urgent",
          amount: { kind: "percent_of_fee", percent: 5 },
          capPercent: 8,
          sourceClause: "§4.2",
        },
      ],
      evals,
      1_000_000,
    );
    expect(lines[0]?.uncappedCents).toBe(100_000);
    expect(totalCents).toBe(80_000);
  });

  it("applies the harshest matching attainment tier", () => {
    const { totalCents } = computeCredits(
      [
        {
          id: "c2",
          basis: "attainment",
          metric: "first_response",
          priority: null,
          tiers: [
            { belowPercent: 99, amount: { kind: "percent_of_fee", percent: 5 } },
            { belowPercent: 95, amount: { kind: "percent_of_fee", percent: 10 } },
            { belowPercent: 90, amount: { kind: "percent_of_fee", percent: 25 } },
          ],
          capPercent: null,
          sourceClause: null,
        },
      ],
      evals,
      1_000_000,
    );
    expect(totalCents).toBe(250_000);
  });
});

describe("parsePolicy", () => {
  it("rejects duplicate targets and solved as a pause status", () => {
    const base = {
      id: "p",
      name: "p",
      calendar: { timezone: "UTC", weekly: { mon: [{ start: "09:00", end: "17:00" }] }, holidays: [] },
      defaultPriority: null,
      targets: [
        { metric: "first_response", priority: "high", minutes: 60, clock: "business" },
        { metric: "first_response", priority: "high", minutes: 30, clock: "business" },
      ],
      pauseStatuses: { resolution: ["solved"] },
    };
    const r = (() => {
      try {
        parsePolicy(base);
        return "";
      } catch (e) {
        return String(e);
      }
    })();
    expect(r).toMatch(/duplicate target/);
    expect(r).toMatch(/cannot be a pause status/);
  });

  it("fills sensible defaults", () => {
    const p = parsePolicy({
      id: "p",
      name: "p",
      calendar: { timezone: "UTC", weekly: { mon: [{ start: "09:00", end: "17:00" }] } },
      defaultPriority: "normal",
      targets: [{ metric: "first_response", priority: "normal", minutes: 60, clock: "business" }],
    });
    expect(p.warnAt).toEqual([0.5, 0.8]);
    expect(p.botRepliesCount).toBe(false);
    expect(p.credits).toEqual([]);
  });
});
