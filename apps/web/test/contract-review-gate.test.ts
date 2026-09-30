import type { SlaPolicy } from "@slai/sla-engine";
import { describe, expect, it } from "vitest";
import { type GateInput, reviewGate } from "../src/pages/contracts/review-gate";

const base: SlaPolicy = {
  id: "p1",
  name: "Kestrel Bank MSA",
  calendar: {
    timezone: "Europe/London",
    weekly: { mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }] },
    holidays: [],
  },
  targets: [
    { metric: "first_response", priority: "urgent", minutes: 30, clock: "calendar" },
    { metric: "first_response", priority: "low", minutes: 600, clock: "business" },
  ],
  defaultPriority: "normal",
  pauseStatuses: { resolution: ["pending"] },
  botRepliesCount: false,
  warnAt: [0.5, 0.8],
  credits: [],
};

const clone = (p: SlaPolicy): SlaPolicy => structuredClone(p);

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    ambiguities: [{ path: "targets.first_response.low" }, { path: "pauseStatuses.resolution" }],
    resolutions: {},
    original: clone(base),
    definition: clone(base),
    role: "admin",
    policyStatus: "draft",
    saving: false,
    ...over,
  };
}

describe("reviewGate", () => {
  it("blocks while any ambiguity is unresolved", () => {
    const r = reviewGate(input({ resolutions: { "targets.first_response.low": { kind: "confirmed" } } }));
    expect(r.canApprove).toBe(false);
    expect(r.unresolved).toEqual(["pauseStatuses.resolution"]);
    expect(r.blockers).toContain("Resolve 1 ambiguity: Pauses · Resolution.");
  });

  it("counts several unresolved ambiguities", () => {
    const r = reviewGate(input());
    expect(r.blockers).toContain("Resolve 2 ambiguities.");
  });

  it("enables approval once every ambiguity is confirmed and the policy is valid", () => {
    const r = reviewGate(
      input({
        resolutions: {
          "targets.first_response.low": { kind: "confirmed" },
          "pauseStatuses.resolution": { kind: "confirmed" },
        },
      }),
    );
    expect(r).toMatchObject({ canApprove: true, blockers: [], unresolved: [] });
  });

  it('treats "changed" as resolved only when the value actually differs', () => {
    const resolutions = {
      "targets.first_response.low": { kind: "changed" as const },
      "pauseStatuses.resolution": { kind: "confirmed" as const },
    };
    const unchanged = reviewGate(input({ resolutions }));
    expect(unchanged.canApprove).toBe(false);
    expect(unchanged.unresolved).toEqual(["targets.first_response.low"]);

    const edited = clone(base);
    edited.targets[1]!.minutes = 480;
    const changed = reviewGate(input({ resolutions, definition: edited }));
    expect(changed.canApprove).toBe(true);
  });

  it("ignores key order when deciding whether a value changed", () => {
    const reordered = clone(base);
    reordered.targets[1] = { clock: "business", minutes: 600, priority: "low", metric: "first_response" };
    const r = reviewGate(
      input({
        definition: reordered,
        resolutions: {
          "targets.first_response.low": { kind: "changed" },
          "pauseStatuses.resolution": { kind: "confirmed" },
        },
      }),
    );
    expect(r.unresolved).toEqual(["targets.first_response.low"]);
  });

  it("blocks an invalid definition with a readable, located message", () => {
    const bad = clone(base);
    bad.pauseStatuses = { resolution: ["pending", "solved"] };
    const r = reviewGate(
      input({
        definition: bad,
        ambiguities: [],
      }),
    );
    expect(r.canApprove).toBe(false);
    expect(r.issues).toEqual([{ path: "pauseStatuses.resolution", message: expect.stringContaining("solved") }]);
    expect(r.blockers[0]).toMatch(/^Pauses · Resolution: "solved" stops clocks/);
  });

  it("maps a bad target to its metric and priority", () => {
    const bad = clone(base);
    bad.targets[0]!.minutes = 0;
    const r = reviewGate(input({ definition: bad, ambiguities: [] }));
    expect(r.issues[0]?.path).toBe("targets.first_response.urgent");
    expect(r.blockers[0]).toMatch(/^First response · Urgent: /);
  });

  it("requires an admin or owner", () => {
    const r = reviewGate(input({ role: "member", ambiguities: [] }));
    expect(r.canApprove).toBe(false);
    expect(r.blockers).toContain("Only admins and owners can approve policies.");
    expect(reviewGate(input({ role: "owner", ambiguities: [] })).canApprove).toBe(true);
  });

  it("blocks non-drafts and in-flight saves", () => {
    expect(reviewGate(input({ policyStatus: "active", ambiguities: [] })).canApprove).toBe(false);
    expect(reviewGate(input({ saving: true, ambiguities: [] })).blockers).toContain("Saving…");
  });
});
