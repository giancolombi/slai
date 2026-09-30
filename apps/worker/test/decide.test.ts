import { describe, expect, it } from "vitest";
import {
  type AutonomyRuleLike,
  actionableCrossing,
  actionableRisk,
  channelsToNotify,
  crossed,
  decideDispatch,
  decideRunLevel,
  decideSendStep,
  findSentComment,
  matchCustomerAccount,
  normalizeBody,
  resolveAutonomy,
  resolvePolicyId,
  spendState,
} from "../src/decide.js";

const acme = { id: "acme", domains: ["acme.com"], externalOrgIds: ["org-1"], policyId: "p-premium" };
const acmeEu = { id: "acme-eu", domains: ["eu.acme.com"], externalOrgIds: [], policyId: null };
const globex = { id: "globex", domains: ["@Globex.io"], externalOrgIds: [], policyId: null };

describe("matchCustomerAccount", () => {
  it("prefers the help-desk org id", () => {
    expect(matchCustomerAccount({ email: "x@globex.io", orgSourceId: "org-1" }, [acme, globex])?.id).toBe("acme");
  });
  it("matches the most specific domain, case-insensitively", () => {
    expect(matchCustomerAccount({ email: "a@eu.acme.com", orgSourceId: null }, [acme, acmeEu])?.id).toBe("acme-eu");
    expect(matchCustomerAccount({ email: "a@us.acme.com", orgSourceId: null }, [acme, acmeEu])?.id).toBe("acme");
    expect(matchCustomerAccount({ email: "A@GLOBEX.IO", orgSourceId: null }, [globex])?.id).toBe("globex");
  });
  it("does not match lookalike domains", () => {
    expect(matchCustomerAccount({ email: "a@notacme.com", orgSourceId: null }, [acme])).toBeNull();
  });
  it("returns null without email or org", () => {
    expect(matchCustomerAccount({ email: null, orgSourceId: null }, [acme])).toBeNull();
  });
});

describe("resolvePolicyId", () => {
  it("uses the account policy, else the default", () => {
    expect(resolvePolicyId(acme, "p-default")).toBe("p-premium");
    expect(resolvePolicyId(acmeEu, "p-default")).toBe("p-default");
    expect(resolvePolicyId(null, null)).toBeNull();
  });
});

const rule = (o: Partial<AutonomyRuleLike>): AutonomyRuleLike => ({
  id: Math.random().toString(36),
  customerAccountId: null,
  priority: null,
  level: "assist",
  triggerAt: "at_risk",
  minConfidence: 0.8,
  ...o,
});

describe("resolveAutonomy", () => {
  const rules = [
    rule({ id: "default", level: "observe" }),
    rule({ id: "urgent", priority: "urgent", level: "assist" }),
    rule({ id: "acme", customerAccountId: "acme", level: "assist" }),
    rule({ id: "acme-urgent", customerAccountId: "acme", priority: "urgent", level: "autopilot" }),
  ];
  it("picks the most specific matching rule", () => {
    expect(resolveAutonomy(rules, { customerAccountId: "acme", priority: "urgent" }).id).toBe("acme-urgent");
    expect(resolveAutonomy(rules, { customerAccountId: "acme", priority: "low" }).id).toBe("acme");
    expect(resolveAutonomy(rules, { customerAccountId: "other", priority: "urgent" }).id).toBe("urgent");
    expect(resolveAutonomy(rules, { customerAccountId: null, priority: "low" }).id).toBe("default");
  });
  it("defaults to observe with no rules", () => {
    expect(resolveAutonomy([], { customerAccountId: null, priority: null }).level).toBe("observe");
  });
});

describe("crossed", () => {
  it("fires only when moving from below to at-or-above", () => {
    expect(crossed("warning", "at_risk", "at_risk")).toBe(true);
    expect(crossed("ok", "breached", "at_risk")).toBe(true);
    expect(crossed(null, "at_risk", "at_risk")).toBe(true);
    expect(crossed("at_risk", "at_risk", "at_risk")).toBe(false);
    expect(crossed("at_risk", "breached", "at_risk")).toBe(false);
    expect(crossed("ok", "warning", "at_risk")).toBe(false);
  });
});

describe("decideDispatch", () => {
  const base = {
    prevRisk: "warning" as const,
    nextRisk: "at_risk" as const,
    actionableRisk: "at_risk" as const,
    ticketOpen: true,
    rule: { level: "autopilot" as const, triggerAt: "at_risk" as const },
    ceiling: "autopilot" as const,
    spend: "ok" as const,
    alreadyHandled: false,
  };
  it("dispatches and allows auto-send on autopilot", () => {
    expect(decideDispatch(base)).toMatchObject({ runTriage: true, runDraft: true, mayAutoSend: true });
  });
  it("drafts without auto-send on assist", () => {
    expect(decideDispatch({ ...base, rule: { ...base.rule, level: "assist" } })).toMatchObject({
      runDraft: true,
      mayAutoSend: false,
    });
  });
  it("never dispatches on observe", () => {
    expect(decideDispatch({ ...base, rule: { ...base.rule, level: "observe" } }).runDraft).toBe(false);
  });
  it("degrades to observe over the spend cap", () => {
    const d = decideDispatch({ ...base, spend: "over_cap" });
    expect(d.runDraft).toBe(false);
    expect(d.effectiveLevel).toBe("observe");
    expect(d.reason).toMatch(/spend cap/);
  });
  it("does not re-dispatch without a new crossing, when handled, or when closed", () => {
    expect(decideDispatch({ ...base, prevRisk: "at_risk" }).runDraft).toBe(false);
    expect(decideDispatch({ ...base, alreadyHandled: true }).runDraft).toBe(false);
    expect(decideDispatch({ ...base, ticketOpen: false }).runDraft).toBe(false);
  });
});

describe("plan ceilings in dispatch (T-65)", () => {
  const base = {
    prevRisk: "warning" as const,
    nextRisk: "at_risk" as const,
    actionableRisk: "at_risk" as const,
    ticketOpen: true,
    rule: { level: "autopilot" as const, triggerAt: "at_risk" as const },
    ceiling: "autopilot" as const,
    spend: "ok" as const,
    alreadyHandled: false,
  };

  it("Starter (triage ceiling) triages but never drafts or sends", () => {
    for (const level of ["assist", "autopilot"] as const) {
      const d = decideDispatch({ ...base, rule: { ...base.rule, level }, ceiling: "triage" });
      expect(d).toMatchObject({ runTriage: true, runDraft: false, mayAutoSend: false, effectiveLevel: "triage" });
      expect(d.reason).toMatch(/plan allows up to triage/);
    }
  });

  it("a trial or Growth (assist ceiling) drafts but never auto-sends", () => {
    const d = decideDispatch({ ...base, ceiling: "assist" });
    expect(d).toMatchObject({ runTriage: true, runDraft: true, mayAutoSend: false, effectiveLevel: "assist" });
  });

  it("Scale (autopilot ceiling) auto-sends", () => {
    expect(decideDispatch(base)).toMatchObject({ runDraft: true, mayAutoSend: true, effectiveLevel: "autopilot" });
  });

  it("an observe ceiling (trial expired, past due beyond grace, canceled) runs nothing", () => {
    const d = decideDispatch({ ...base, ceiling: "observe" });
    expect(d).toMatchObject({ runTriage: false, runDraft: false, effectiveLevel: "observe" });
    expect(d.reason).toMatch(/plan allows observe only/);
  });

  it("the ceiling never raises a rule", () => {
    expect(decideDispatch({ ...base, rule: { ...base.rule, level: "observe" } }).runTriage).toBe(false);
    expect(decideDispatch({ ...base, rule: { ...base.rule, level: "assist" } }).mayAutoSend).toBe(false);
  });

  it("the spend cap still wins over the plan", () => {
    expect(decideDispatch({ ...base, spend: "over_cap" }).reason).toMatch(/spend cap/);
  });
});

describe("decideRunLevel (T-65)", () => {
  const base = { kind: "draft_reply" as const, ruleLevel: "autopilot" as const, manual: false, spend: "ok" as const };

  it("caps a run at the plan's ceiling", () => {
    expect(decideRunLevel({ ...base, ceiling: "assist" }).level).toBe("assist");
    expect(decideRunLevel({ ...base, ceiling: "autopilot" }).level).toBe("autopilot");
  });

  it("a draft on a triage-only plan does not run; a triage does", () => {
    expect(decideRunLevel({ ...base, ceiling: "triage" })).toEqual({
      level: "observe",
      reason: "plan allows triage only",
    });
    expect(decideRunLevel({ ...base, kind: "triage", ceiling: "triage" }).level).toBe("triage");
  });

  it("a manual run lifts observe to assist, but not past the plan", () => {
    const manual = { ...base, ruleLevel: "observe" as const, manual: true };
    expect(decideRunLevel({ ...manual, ceiling: "autopilot" }).level).toBe("assist");
    expect(decideRunLevel({ ...manual, ceiling: "observe" }).level).toBe("observe");
    expect(decideRunLevel({ ...manual, kind: "triage", ceiling: "triage" }).level).toBe("triage");
  });

  it("nothing runs over the spend cap", () => {
    expect(decideRunLevel({ ...base, ceiling: "autopilot", spend: "over_cap" }).reason).toMatch(/spend cap/);
  });
});

describe("first evaluation (T-48)", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const live = (risk: "ok" | "warning" | "at_risk", state = "running") => ({
    state,
    risk,
    cycles: [{ stoppedAt: null, breachAt: new Date(now.getTime() + 3_600_000) }],
  });
  const breachedLive = (minAgo: number) => ({
    state: "breached",
    risk: "breached" as const,
    cycles: [{ stoppedAt: null, breachAt: ago(minAgo) }],
  });
  const breachedStopped = {
    state: "breached",
    risk: "breached" as const,
    cycles: [{ stoppedAt: ago(30), breachAt: ago(600) }],
  };

  it("a live breach within the grace window is actionable", () => {
    expect(actionableRisk([breachedLive(10)], now)).toBe("breached");
    expect(actionableRisk([breachedLive(60)], now)).toBe("breached");
  });
  it("a live breach older than the grace window is not", () => {
    expect(actionableRisk([breachedLive(61)], now)).toBe("ok");
    expect(actionableRisk([breachedLive(3 * 24 * 60)], now)).toBe("ok");
    expect(actionableRisk([breachedLive(90)], now, 2 * 3_600_000)).toBe("breached");
  });
  it("stopped cycles never count; other live metrics still do", () => {
    expect(actionableRisk([breachedStopped], now)).toBe("ok");
    expect(actionableRisk([breachedStopped, live("at_risk")], now)).toBe("at_risk");
    expect(actionableRisk([breachedLive(600), live("warning", "paused")], now)).toBe("warning");
    expect(actionableRisk([{ state: "not_applicable", risk: "ok", cycles: [] }], now)).toBe("ok");
  });
  it("only a first evaluation is filtered", () => {
    expect(actionableCrossing(null, "breached", "ok", "at_risk")).toBe(false);
    expect(actionableCrossing(null, "breached", "at_risk", "at_risk")).toBe(true);
    expect(actionableCrossing("warning", "breached", "ok", "at_risk")).toBe(true);
    expect(actionableCrossing(null, "warning", "warning", "at_risk")).toBe(false);
  });
  it("decideDispatch skips a long-breached ticket on first sight, and dispatches a fresh one", () => {
    const first = {
      prevRisk: null,
      nextRisk: "breached" as const,
      ticketOpen: true,
      rule: { level: "assist" as const, triggerAt: "at_risk" as const },
      ceiling: "autopilot" as const,
      spend: "ok" as const,
      alreadyHandled: false,
    };
    const stale = decideDispatch({ ...first, actionableRisk: "ok" });
    expect(stale.runDraft).toBe(false);
    expect(stale.reason).toMatch(/grace window/);
    expect(decideDispatch({ ...first, actionableRisk: "breached" }).runDraft).toBe(true);
    expect(decideDispatch({ ...first, nextRisk: "at_risk", actionableRisk: "at_risk" }).runDraft).toBe(true);
    // Once seen, a later crossing dispatches normally.
    expect(decideDispatch({ ...first, prevRisk: "warning", actionableRisk: "ok" }).runDraft).toBe(true);
  });
});

describe("channelsToNotify", () => {
  it("notifies each enabled channel once when its minimum is crossed", () => {
    const chans = [
      { id: "a", minRisk: "warning" as const, enabled: true },
      { id: "b", minRisk: "breached" as const, enabled: true },
      { id: "c", minRisk: "warning" as const, enabled: false },
    ];
    expect(channelsToNotify(chans, "ok", "at_risk", "at_risk").map((c) => c.id)).toEqual(["a"]);
    expect(channelsToNotify(chans, "at_risk", "breached", "breached").map((c) => c.id)).toEqual(["b"]);
  });
  it("on a first evaluation, notifies only for the actionable risk", () => {
    const chans = [
      { id: "warn", minRisk: "warning" as const, enabled: true },
      { id: "breach", minRisk: "breached" as const, enabled: true },
    ];
    // Long breached, but a live metric is at warning: only the warning channel hears about it.
    expect(channelsToNotify(chans, null, "breached", "warning").map((c) => c.id)).toEqual(["warn"]);
    expect(channelsToNotify(chans, null, "breached", "ok")).toEqual([]);
    expect(channelsToNotify(chans, null, "breached", "breached").map((c) => c.id)).toEqual(["warn", "breach"]);
  });
});

describe("spendState", () => {
  it("compares credits used with the cap in credits", () => {
    expect(spendState(99, 100)).toBe("ok");
    expect(spendState(100, 100)).toBe("over_cap");
    expect(spendState(0, 0)).toBe("over_cap");
    expect(spendState(10 ** 9, null)).toBe("ok");
  });
});

describe("idempotent writes (T-49)", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("decideSendStep claims approved, waits on a fresh claim, reconciles a stale one", () => {
    expect(decideSendStep({ status: "approved", sendingAt: null }, now)).toBe("claim");
    expect(decideSendStep({ status: "sending", sendingAt: minAgo(1) }, now)).toBe("wait");
    expect(decideSendStep({ status: "sending", sendingAt: minAgo(5) }, now)).toBe("reconcile");
    expect(decideSendStep({ status: "sending", sendingAt: null }, now)).toBe("reconcile");
    for (const status of ["sent", "failed", "rejected", "proposed", "blocked"]) {
      expect(decideSendStep({ status, sendingAt: minAgo(60) }, now)).toBe("done");
    }
  });

  it("normalizes whitespace, case and unicode forms", () => {
    expect(normalizeBody("  Hello,\n\n  World !  ")).toBe("hello, world !");
  });

  describe("findSentComment", () => {
    const reply = { kind: "public_reply", body: "Thanks!\n\nWe are on it.", sendingAt: minAgo(10) };
    const c = (o: Partial<Parameters<typeof findSentComment>[1][number]>) => ({
      sourceId: "c1",
      at: minAgo(9),
      public: true,
      authorRole: "agent",
      bodyText: "Thanks! We are on it.",
      ...o,
    });
    it("finds our reply by normalized body after the claim", () => {
      expect(findSentComment(reply, [c({})])).toBe("c1");
      expect(findSentComment(reply, [c({ at: minAgo(11) })])).toBe("c1"); // within clock skew
    });
    it("ignores other visibility, requester text, older comments and other bodies", () => {
      expect(findSentComment(reply, [c({ public: false })])).toBeNull();
      expect(findSentComment(reply, [c({ authorRole: "requester" })])).toBeNull();
      expect(findSentComment(reply, [c({ at: minAgo(30) })])).toBeNull();
      expect(findSentComment(reply, [c({ bodyText: "Thanks! We are on it. Also…" })])).toBeNull();
      expect(findSentComment({ ...reply, kind: "internal_note" }, [c({})])).toBeNull();
      expect(findSentComment({ ...reply, kind: "set_priority" }, [c({})])).toBeNull();
    });
    it("skips comments already recorded for another action", () => {
      expect(findSentComment(reply, [c({ sourceId: "c1" })], { knownRefs: ["c1"] })).toBeNull();
      expect(
        findSentComment(reply, [c({ sourceId: "c1" }), c({ sourceId: "c2", at: minAgo(8) })], { knownRefs: ["c1"] }),
      ).toBe("c2");
    });
    it("matches a help desk's truncated copy of a long body", () => {
      const long = "x".repeat(300);
      expect(findSentComment({ ...reply, body: long }, [c({ bodyText: `${"x".repeat(250)}…` })])).toBe("c1");
      expect(findSentComment({ ...reply, body: long }, [c({ bodyText: `${"x".repeat(50)}…` })])).toBeNull();
    });
  });
});
