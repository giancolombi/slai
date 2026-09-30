import type { AutonomyRule, Priority } from "@slai/shared";

export type RuleSource = "exact" | "customer" | "priority" | "default" | "none";

export interface Resolution {
  /** The rule that applies to this scope, if any. */
  rule: AutonomyRule | null;
  /** Where it came from, relative to the requested scope. "exact" means the rule is defined for this cell. */
  source: RuleSource;
}

/**
 * The effective autonomy rule for a (customer, priority) scope. Most specific wins:
 * customer + priority > customer > priority > default. `null` in the scope means "any".
 */
export function resolveRule(
  rules: readonly AutonomyRule[],
  customerAccountId: string | null,
  priority: Priority | null,
): Resolution {
  const find = (c: string | null, p: Priority | null) =>
    rules.find((r) => r.customerAccountId === c && r.priority === p) ?? null;

  const candidates: [string | null, Priority | null][] = [];
  if (customerAccountId !== null && priority !== null) candidates.push([customerAccountId, priority]);
  if (customerAccountId !== null) candidates.push([customerAccountId, null]);
  if (priority !== null) candidates.push([null, priority]);
  candidates.push([null, null]);

  for (const [c, p] of candidates) {
    const rule = find(c, p);
    if (!rule) continue;
    const exact = c === customerAccountId && p === priority;
    const source: RuleSource = exact ? "exact" : c !== null ? "customer" : p !== null ? "priority" : "default";
    return { rule, source };
  }
  return { rule: null, source: "none" };
}

/** The rule defined for exactly this scope, if any. */
export function exactRule(rules: readonly AutonomyRule[], customerAccountId: string | null, priority: Priority | null) {
  return rules.find((r) => r.customerAccountId === customerAccountId && r.priority === priority) ?? null;
}
