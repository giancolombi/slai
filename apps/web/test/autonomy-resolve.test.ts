import type { AutonomyRule } from "@slai/shared";
import { describe, expect, it } from "vitest";
import { exactRule, resolveRule } from "../src/pages/autonomy/resolve";

const rule = (
  id: string,
  customerAccountId: string | null,
  priority: AutonomyRule["priority"],
  level: AutonomyRule["level"],
) => ({ id, customerAccountId, priority, level, triggerAt: "at_risk", minConfidence: 0.8 }) satisfies AutonomyRule;

const rules: AutonomyRule[] = [
  rule("default", null, null, "assist"),
  rule("urgent", null, "urgent", "observe"),
  rule("acme", "acme", null, "autopilot"),
  rule("acme-urgent", "acme", "urgent", "assist"),
];

describe("resolveRule", () => {
  it("uses the exact customer + priority rule first", () => {
    expect(resolveRule(rules, "acme", "urgent")).toEqual({ rule: rules[3], source: "exact" });
  });

  it("prefers the customer rule over the priority rule", () => {
    expect(resolveRule(rules, "acme", "high")).toEqual({ rule: rules[2], source: "customer" });
  });

  it("falls back to the priority rule, then the default", () => {
    expect(resolveRule(rules, "globex", "urgent")).toEqual({ rule: rules[1], source: "priority" });
    expect(resolveRule(rules, "globex", "low")).toEqual({ rule: rules[0], source: "default" });
  });

  it("marks rules defined for the scope itself as exact", () => {
    expect(resolveRule(rules, null, null).source).toBe("exact");
    expect(resolveRule(rules, "acme", null).source).toBe("exact");
    expect(resolveRule(rules, null, "urgent").source).toBe("exact");
  });

  it("returns none when nothing matches", () => {
    expect(resolveRule([], "acme", "low")).toEqual({ rule: null, source: "none" });
  });

  it("finds exact rules only", () => {
    expect(exactRule(rules, "acme", "high")).toBeNull();
    expect(exactRule(rules, "acme", null)?.id).toBe("acme");
  });
});
