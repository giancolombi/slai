import { describe, expect, it } from "vitest";
import { EvaluationError, evaluateTicket, type Metric, type TicketEvaluation } from "../src/index.js";
import {
  agentReply,
  at,
  botReply,
  created,
  internalNote,
  policy,
  priority,
  requesterReply,
  status,
} from "./fixtures.js";

const MIN = 60_000;
const H = 60 * MIN;
const metric = (ev: TicketEvaluation, m: Metric) => {
  const r = ev.metrics.find((x) => x.metric === m);
  if (!r) throw new Error(`no ${m}`);
  return r;
};

// Mon 2026-10-05, EDT (UTC-4). 13:00Z = 09:00 local.
describe("first_response", () => {
  it("is achieved when an agent replies within target", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "high"), agentReply("2026-10-05T14:00:00Z")],
      at("2026-10-05T18:00:00Z"),
    );
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("achieved");
    expect(fr.elapsedMs).toBe(1 * H);
    expect(fr.risk).toBe("ok");
    expect(fr.dueAt).toBeNull();
  });

  it("is running with a business-hours due time", () => {
    // High: 120 business minutes. Created Fri 16:00 local → due Mon 10:00 local.
    const ev = evaluateTicket(policy(), [created("2026-10-02T20:00:00Z", "high")], at("2026-10-03T12:00:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("running");
    expect(fr.elapsedMs).toBe(1 * H);
    expect(fr.remainingMs).toBe(1 * H);
    expect(fr.dueAt?.toISOString()).toBe("2026-10-05T14:00:00.000Z");
    expect(fr.risk).toBe("warning"); // 50% consumed, warnAt [0.5, 0.8]
  });

  it("breaches, records the breach instant, and reports negative remaining", () => {
    const ev = evaluateTicket(policy(), [created("2026-10-05T13:00:00Z", "urgent")], at("2026-10-05T14:30:00Z"));
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("breached");
    expect(fr.remainingMs).toBe(-30 * MIN);
    expect(fr.cycles[0]?.breachAt?.toISOString()).toBe("2026-10-05T14:00:00.000Z");
    expect(ev.risk).toBe("breached");
  });

  it("stays breached after a late reply", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "urgent"), agentReply("2026-10-05T15:00:00Z")],
      at("2026-10-05T16:00:00Z"),
    );
    expect(metric(ev, "first_response").state).toBe("breached");
    expect(metric(ev, "first_response").breachCount).toBe(1);
  });

  it("ignores internal notes and requester comments", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        internalNote("2026-10-05T13:10:00Z"),
        requesterReply("2026-10-05T13:20:00Z"),
      ],
      at("2026-10-05T13:30:00Z"),
    );
    expect(metric(ev, "first_response").state).toBe("running");
  });

  it("counts bot replies only when the policy says so", () => {
    const events = [created("2026-10-05T13:00:00Z", "high"), botReply("2026-10-05T13:01:00Z")];
    const now = at("2026-10-05T13:30:00Z");
    expect(metric(evaluateTicket(policy(), events, now), "first_response").state).toBe("running");
    expect(metric(evaluateTicket(policy({ botRepliesCount: true }), events, now), "first_response").state).toBe(
      "achieved",
    );
  });

  it("is satisfied by solving the ticket", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "high"), status("2026-10-05T13:30:00Z", "solved")],
      at("2026-10-05T18:00:00Z"),
    );
    expect(metric(ev, "first_response").state).toBe("achieved");
  });
});

describe("priority handling", () => {
  it("applies the current priority's target to a running clock", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "normal"), priority("2026-10-05T13:30:00Z", "urgent")],
      at("2026-10-05T14:30:00Z"),
    );
    // 90 calendar minutes elapsed against the urgent 60-minute target.
    const fr = metric(ev, "first_response");
    expect(fr.state).toBe("breached");
    expect(fr.clock).toBe("calendar");
  });

  it("freezes the target at the priority in effect when the cycle stopped", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        agentReply("2026-10-05T14:30:00Z"), // 90 min < 120 high target
        priority("2026-10-05T15:00:00Z", "urgent"),
      ],
      at("2026-10-05T16:00:00Z"),
    );
    expect(metric(ev, "first_response").state).toBe("achieved");
  });

  it("falls back to the default priority, or measures nothing without one", () => {
    const events = [created("2026-10-05T13:00:00Z", null)];
    const now = at("2026-10-05T14:00:00Z");
    expect(metric(evaluateTicket(policy(), events, now), "first_response").targetMs).toBe(480 * MIN);
    const none = evaluateTicket(policy({ defaultPriority: null }), events, now);
    expect(metric(none, "first_response").state).toBe("not_applicable");
    expect(none.risk).toBe("ok");
  });
});

describe("resolution", () => {
  it("pauses while pending and resumes when the customer replies", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        agentReply("2026-10-05T14:00:00Z"),
        status("2026-10-05T14:00:00Z", "pending"),
        requesterReply("2026-10-06T13:00:00Z"),
        status("2026-10-06T13:00:00Z", "open"),
      ],
      at("2026-10-06T15:00:00Z"),
    );
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(3 * H); // 1h Monday + 2h Tuesday; the pending period is excluded
  });

  it("reports paused with no due time while pending", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "high"), status("2026-10-05T14:00:00Z", "pending")],
      at("2026-10-05T18:00:00Z"),
    );
    const res = metric(ev, "resolution");
    expect(res.state).toBe("paused");
    expect(res.dueAt).toBeNull();
    expect(res.elapsedMs).toBe(1 * H);
  });

  it("accumulates across a reopen", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        agentReply("2026-10-05T13:30:00Z"),
        status("2026-10-05T15:00:00Z", "solved"),
        requesterReply("2026-10-06T13:00:00Z"),
        status("2026-10-06T13:00:00Z", "open"),
      ],
      at("2026-10-06T14:00:00Z"),
    );
    const res = metric(ev, "resolution");
    expect(res.state).toBe("running");
    expect(res.elapsedMs).toBe(3 * H);
    expect(res.cycles).toHaveLength(1);
  });

  it("is achieved when solved within target", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "high"), status("2026-10-05T15:00:00Z", "solved")],
      at("2026-10-09T15:00:00Z"),
    );
    expect(metric(ev, "resolution").state).toBe("achieved");
    expect(ev.mostUrgent).toBeNull();
  });
});

describe("next_response", () => {
  it("starts on each customer reply after the first response and measures each cycle", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        agentReply("2026-10-05T13:30:00Z"),
        requesterReply("2026-10-05T14:00:00Z"),
        agentReply("2026-10-05T15:00:00Z"), // 1h < 4h: achieved
        requesterReply("2026-10-05T16:00:00Z"),
        requesterReply("2026-10-05T16:30:00Z"), // does not restart the running cycle
      ],
      at("2026-10-06T17:00:00Z"),
    );
    const nr = metric(ev, "next_response");
    expect(nr.cycles).toHaveLength(2);
    expect(nr.cycles[0]?.state).toBe("achieved");
    // Second cycle: Mon 12:00–17:00 local (5h) + Tue 09:00–13:00 (4h) = 9h > 4h.
    expect(nr.state).toBe("breached");
    expect(nr.breachCount).toBe(1);
    expect(nr.cycles[1]?.breachAt?.toISOString()).toBe("2026-10-05T20:00:00.000Z");
  });

  it("does not start before the first response", () => {
    const ev = evaluateTicket(
      policy(),
      [created("2026-10-05T13:00:00Z", "high"), requesterReply("2026-10-05T13:10:00Z")],
      at("2026-10-05T13:20:00Z"),
    );
    expect(metric(ev, "next_response").state).toBe("not_applicable");
  });

  it("starts from the customer's comment when it reopens a solved ticket", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        agentReply("2026-10-05T13:30:00Z"),
        status("2026-10-05T14:00:00Z", "solved"),
        requesterReply("2026-10-06T13:00:00Z"),
        status("2026-10-06T13:05:00Z", "open"),
      ],
      at("2026-10-06T14:00:00Z"),
    );
    const nr = metric(ev, "next_response");
    expect(nr.state).toBe("running");
    expect(nr.cycles[0]?.startedAt.toISOString()).toBe("2026-10-06T13:00:00.000Z");
  });
  it("does not run on a solved ticket the customer comments on without reopening", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "high"),
        agentReply("2026-10-05T13:30:00Z"),
        status("2026-10-05T14:00:00Z", "solved"),
        requesterReply("2026-10-06T13:00:00Z"),
      ],
      at("2026-10-09T14:00:00Z"),
    );
    expect(metric(ev, "next_response").state).toBe("not_applicable");
    expect(ev.mostUrgent).toBeNull();
  });
});

describe("periodic_update", () => {
  it("requires an agent update at least every N minutes while open", () => {
    const ev = evaluateTicket(
      policy(),
      [
        created("2026-10-05T13:00:00Z", "urgent"),
        agentReply("2026-10-05T13:20:00Z"),
        agentReply("2026-10-05T15:00:00Z"), // 100 min < 120: achieved
      ],
      at("2026-10-05T17:30:00Z"), // 150 min since last update
    );
    const pu = metric(ev, "periodic_update");
    expect(pu.cycles.map((c) => c.state)).toEqual(["achieved", "breached"]);
  });
});

describe("evaluation time", () => {
  it("ignores events after `now`, so history can be replayed", () => {
    const events = [created("2026-10-05T13:00:00Z", "urgent"), agentReply("2026-10-05T13:45:00Z")];
    expect(metric(evaluateTicket(policy(), events, at("2026-10-05T13:30:00Z")), "first_response").state).toBe(
      "running",
    );
    expect(metric(evaluateTicket(policy(), events, at("2026-10-05T14:30:00Z")), "first_response").state).toBe(
      "achieved",
    );
  });

  it("is order-insensitive to input order", () => {
    const events = [
      agentReply("2026-10-05T13:45:00Z"),
      status("2026-10-05T14:00:00Z", "solved"),
      created("2026-10-05T13:00:00Z", "urgent"),
    ];
    const ev = evaluateTicket(policy(), events, at("2026-10-05T15:00:00Z"));
    expect(metric(ev, "first_response").state).toBe("achieved");
    expect(metric(ev, "resolution").state).toBe("achieved");
  });

  it("rejects histories without a created event", () => {
    expect(() => evaluateTicket(policy(), [agentReply("2026-10-05T13:45:00Z")], at("2026-10-05T15:00:00Z"))).toThrow(
      EvaluationError,
    );
  });

  it("picks the live metric closest to breaching as mostUrgent", () => {
    const ev = evaluateTicket(policy(), [created("2026-10-05T13:00:00Z", "urgent")], at("2026-10-05T13:50:00Z"));
    expect(ev.mostUrgent?.metric).toBe("first_response");
    expect(ev.mostUrgent?.remainingMs).toBe(10 * MIN);
    expect(ev.mostUrgent?.risk).toBe("at_risk");
  });
});
