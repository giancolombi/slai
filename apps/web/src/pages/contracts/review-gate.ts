/**
 * Whether an extracted draft policy may be approved, and if not, why.
 * Pure so it can be tested without rendering the review screen.
 */
import type { PolicyStatus, Role } from "@slai/shared";
import { policySchema, type SlaPolicy } from "@slai/sla-engine";
import { issueToPath, normalizeDefinition, pathLabel, sameValue, valueAtPath } from "./policy-paths";

export type Resolution = { kind: "confirmed" } | { kind: "changed" };

export interface GateAmbiguity {
  path: string;
}

export interface GateInput {
  ambiguities: GateAmbiguity[];
  resolutions: Record<string, Resolution | undefined>;
  /** The definition as extracted (before edits). */
  original: SlaPolicy;
  /** The definition as edited now. */
  definition: SlaPolicy;
  role: Role;
  policyStatus: PolicyStatus;
  saving: boolean;
}

export interface FieldIssue {
  path: string;
  message: string;
}

export interface GateResult {
  canApprove: boolean;
  blockers: string[];
  /** Ambiguity paths that still need a decision. */
  unresolved: string[];
  /** Schema problems mapped to citation paths, for inline field errors. */
  issues: FieldIssue[];
}

/** A "changed" resolution only counts once the value really differs from the extraction. */
export function isResolved(input: Pick<GateInput, "resolutions" | "original" | "definition">, path: string): boolean {
  const r = input.resolutions[path];
  if (!r) return false;
  if (r.kind === "confirmed") return true;
  return !sameValue(valueAtPath(input.original, path), valueAtPath(input.definition, path));
}

export function validateDefinition(definition: SlaPolicy): FieldIssue[] {
  const result = policySchema.safeParse(definition);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issueToPath(issue.path, definition);
    return { path, message: issue.message };
  });
}

export function reviewGate(input: GateInput): GateResult {
  const blockers: string[] = [];
  const definition = normalizeDefinition(input.definition);

  if (input.policyStatus !== "draft") blockers.push("Only draft policies can be approved.");
  if (input.role !== "owner" && input.role !== "admin") blockers.push("Only admins and owners can approve policies.");

  const unresolved = input.ambiguities.map((a) => a.path).filter((p) => !isResolved(input, p));
  if (unresolved.length === 1) blockers.push(`Resolve 1 ambiguity: ${pathLabel(unresolved[0]!, definition)}.`);
  else if (unresolved.length > 1) blockers.push(`Resolve ${unresolved.length} ambiguities.`);

  const issues = validateDefinition(definition);
  for (const issue of issues.slice(0, 3)) {
    blockers.push(`${pathLabel(issue.path, definition)}: ${readable(issue.message)}`);
  }
  if (issues.length > 3) blockers.push(`…and ${issues.length - 3} more problems in the policy.`);

  if (input.saving) blockers.push("Saving…");

  return { canApprove: blockers.length === 0, blockers, unresolved, issues };
}

function readable(message: string) {
  const m = message.replace(/^Invalid input: /, "");
  return m.charAt(0).toLowerCase() + m.slice(1);
}
