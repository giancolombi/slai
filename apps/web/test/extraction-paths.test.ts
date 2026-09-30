import { describe, expect, it } from "vitest";
import { extractionPath, normalizeDefinition } from "../src/pages/contracts/policy-paths";

const def = normalizeDefinition({
  name: "Support SLA",
  calendar: { timezone: "America/Los_Angeles", weekly: { mon: [{ start: "07:00", end: "19:00" }] }, holidays: [] },
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 60, clock: "business" },
    { metric: "resolution", priority: "urgent", minutes: 720, clock: "business" },
  ],
  credits: [
    {
      id: "c-urgent",
      basis: "per_breach",
      metric: "resolution",
      priority: "urgent",
      amount: { kind: "fixed_cents", cents: 50000 },
      capPercent: null,
      sourceClause: null,
    },
  ],
});

describe("extractionPath", () => {
  it("maps index-based, policy-scoped extraction paths to semantic paths", () => {
    expect(extractionPath("policies[0].targets[1]", 0, def)).toBe("targets.resolution.urgent");
    expect(extractionPath("policies[0].targets[0].minutes", 0, def)).toBe("targets.first_response.urgent");
    expect(extractionPath("policies[0].credits[0].amount", 0, def)).toBe("credits.c-urgent");
    expect(extractionPath("policies[0].calendar.weekly.mon", 0, def)).toBe("calendar.weekly");
    expect(extractionPath("policies[0].calendar.holidays", 0, def)).toBe("calendar.holidays");
    expect(extractionPath("policies[0].pauseStatuses.resolution", 0, def)).toBe("pauseStatuses.resolution");
  });

  it("drops paths that belong to another policy of the same contract", () => {
    expect(extractionPath("policies[1].targets[0]", 0, def)).toBeNull();
  });

  it("passes semantic paths through", () => {
    expect(extractionPath("targets.resolution.urgent", 0, def)).toBe("targets.resolution.urgent");
    expect(extractionPath("calendar.timezone", 0, def)).toBe("calendar.timezone");
  });
});
