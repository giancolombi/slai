import { describe, expect, it } from "vitest";
import { evaluateTicket, nextTransitionAt } from "../src/index.js";
import { agentReply, at, created, policy, status } from "./fixtures.js";

describe("nextTransitionAt", () => {
  it("returns the next warn threshold of the running clock", () => {
    const p = policy();
    // urgent first response: 60 calendar min; warnAt [0.5, 0.8] → 30m, 48m, then breach.
    const ev = evaluateTicket(p, [created("2026-10-05T13:00:00Z", "urgent")], at("2026-10-05T13:10:00Z"));
    expect(nextTransitionAt(p, ev)?.toISOString()).toBe("2026-10-05T13:30:00.000Z");
  });

  it("moves to the next threshold, then to just past the breach", () => {
    const p = policy();
    const events = [created("2026-10-05T13:00:00Z", "urgent")];
    expect(nextTransitionAt(p, evaluateTicket(p, events, at("2026-10-05T13:30:00Z")))?.toISOString()).toBe(
      "2026-10-05T13:48:00.000Z",
    );
    expect(nextTransitionAt(p, evaluateTicket(p, events, at("2026-10-05T13:50:00Z")))?.toISOString()).toBe(
      "2026-10-05T14:00:00.001Z",
    );
  });

  it("follows business hours for business clocks", () => {
    const p = policy();
    // high first response: 120 business min. Created Fri 16:00 local; the 50% (60m) mark is Fri 17:00 local.
    const ev = evaluateTicket(p, [created("2026-10-02T20:00:00Z", "high")], at("2026-10-02T20:30:00Z"));
    expect(nextTransitionAt(p, ev)?.toISOString()).toBe("2026-10-02T21:00:00.000Z");
  });

  it("is null when nothing is running", () => {
    const p = policy();
    const solved = evaluateTicket(
      p,
      [
        created("2026-10-05T13:00:00Z", "urgent"),
        agentReply("2026-10-05T13:10:00Z"),
        status("2026-10-05T13:20:00Z", "solved"),
      ],
      at("2026-10-05T14:00:00Z"),
    );
    expect(nextTransitionAt(p, solved)).toBeNull();
  });

  it("considers the earliest across metrics and ignores breached clocks", () => {
    const p = policy();
    // At 14:30 the urgent first response is breached (no further transition);
    // resolution (480 calendar min) crosses 50% at 17:00.
    const ev = evaluateTicket(p, [created("2026-10-05T13:00:00Z", "urgent")], at("2026-10-05T14:30:00Z"));
    expect(nextTransitionAt(p, ev)?.toISOString()).toBe("2026-10-05T17:00:00.000Z");
  });
});
