import type { AgentAction } from "@slai/shared";

/**
 * Who did something, for display. The API sends the user id (`approvedBy`, `uploadedBy`,
 * `decidedBy`) and the display name alongside (`…ByName`), so nothing is looked up here.
 * A user id without a name belongs to a deleted user.
 */
export function personLabel(id: string | null | undefined, name: string | null | undefined): string | null {
  if (name) return name;
  return id ? "A former member" : null;
}

/** Who approved or rejected an action. Decided without a person: slai did it (autopilot or an assist note). */
export function deciderLabel(a: Pick<AgentAction, "decidedBy" | "decidedByName" | "decidedAt" | "kind">) {
  const person = personLabel(a.decidedBy, a.decidedByName);
  if (person) return person;
  if (!a.decidedAt) return null;
  return a.kind === "public_reply" ? "Autopilot" : "slai";
}
