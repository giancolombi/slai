import type { ActionStatus, Autonomy, Metric, Priority, Role, TicketStatus } from "@slai/shared";

export const METRIC_LABEL: Record<Metric, string> = {
  first_response: "First response",
  next_response: "Next response",
  periodic_update: "Periodic update",
  resolution: "Resolution",
};

export const METRIC_SHORT: Record<Metric, string> = {
  first_response: "FRT",
  next_response: "NRT",
  periodic_update: "Update",
  resolution: "Resolve",
};

export const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low"];
export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export const STATUSES: TicketStatus[] = ["new", "open", "pending", "on_hold", "solved", "closed"];
export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Pending",
  on_hold: "On hold",
  solved: "Solved",
  closed: "Closed",
};

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
export const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including billing and roles",
  admin: "Manage policies, connections, autonomy and members",
  member: "Work tickets and approve drafts",
  viewer: "Read-only access",
};

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  observe: "Observe",
  assist: "Assist",
  autopilot: "Autopilot",
};
export const AUTONOMY_HELP: Record<Autonomy, string> = {
  observe:
    "Alerts only. slai watches the clock and notifies your team in-app, by email or in Slack. Agents never touch the ticket.",
  assist:
    "Agents triage and draft a reply in a sandbox. The draft is posted as an internal note and queued here for one-click approval. A human always sends it.",
  autopilot:
    "Same as assist, and when a draft passes every guardrail (confidence threshold, no pricing, legal or policy commitments), slai sends it as the public reply.",
};

export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  proposed: "Awaiting approval",
  approved: "Approved",
  sent: "Sent",
  rejected: "Rejected",
  failed: "Failed",
  blocked: "Blocked by guardrail",
};

export const PROVIDER_LABEL: Record<string, string> = {
  zendesk: "Zendesk",
  jira_sm: "Jira Service Management",
  intercom: "Intercom",
  freshdesk: "Freshdesk",
  hubspot: "HubSpot",
  zammad: "Zammad",
  help_scout: "Help Scout",
  demo: "Demo",
};

export function providerLabel(p: string) {
  return PROVIDER_LABEL[p] ?? p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const PLANS = [
  { id: "replay", name: "Replay", priceCents: 0, tickets: 0, blurb: "One-time 90-day Breach Replay" },
  { id: "starter", name: "Starter", priceCents: 29_900, tickets: 1_500, blurb: "Observe + triage" },
  { id: "growth", name: "Growth", priceCents: 99_900, tickets: 7_500, blurb: "Assist (drafts)" },
  { id: "scale", name: "Scale", priceCents: 249_900, tickets: 25_000, blurb: "Autopilot" },
] as const;
