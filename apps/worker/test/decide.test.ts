import { describe, expect, it } from "vitest";
import {
  type AutonomyRuleLike,
  channelsToNotify,
  crossed,
  decideDispatch,
  matchCustomerAccount,
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
    ticketOpen: true,
    rule: { level: "autopilot" as const, triggerAt: "at_risk" as const },
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

describe("channelsToNotify", () => {
  it("notifies each enabled channel once when its minimum is crossed", () => {
    const chans = [
      { id: "a", minRisk: "warning" as const, enabled: true },
      { id: "b", minRisk: "breached" as const, enabled: true },
      { id: "c", minRisk: "warning" as const, enabled: false },
    ];
    expect(channelsToNotify(chans, "ok", "at_risk").map((c) => c.id)).toEqual(["a"]);
    expect(channelsToNotify(chans, "at_risk", "breached").map((c) => c.id)).toEqual(["b"]);
  });
});

describe("spendState", () => {
  it("compares micro-dollars to a cents cap", () => {
    expect(spendState(999_999, 100)).toBe("ok");
    expect(spendState(1_000_000, 100)).toBe("over_cap");
    expect(spendState(10 ** 12, null)).toBe("ok");
  });
});
