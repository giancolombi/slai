import { type PolicyInput, parsePolicy, type TicketEvent } from "../src/index.js";

export const NY_BUSINESS = {
  timezone: "America/New_York",
  weekly: {
    mon: [{ start: "09:00", end: "17:00" }],
    tue: [{ start: "09:00", end: "17:00" }],
    wed: [{ start: "09:00", end: "17:00" }],
    thu: [{ start: "09:00", end: "17:00" }],
    fri: [{ start: "09:00", end: "17:00" }],
  },
  holidays: ["2026-10-12"],
};

export function policy(overrides: Partial<PolicyInput> = {}) {
  return parsePolicy({
    id: "pol_1",
    name: "Enterprise",
    calendar: NY_BUSINESS,
    defaultPriority: "normal",
    targets: [
      { metric: "first_response", priority: "urgent", minutes: 60, clock: "calendar" },
      { metric: "first_response", priority: "high", minutes: 120, clock: "business" },
      { metric: "first_response", priority: "normal", minutes: 480, clock: "business" },
      { metric: "next_response", priority: "high", minutes: 240, clock: "business" },
      { metric: "next_response", priority: "normal", minutes: 480, clock: "business" },
      { metric: "periodic_update", priority: "urgent", minutes: 120, clock: "calendar" },
      { metric: "resolution", priority: "urgent", minutes: 480, clock: "calendar" },
      { metric: "resolution", priority: "high", minutes: 1440, clock: "business" },
      { metric: "resolution", priority: "normal", minutes: 2400, clock: "business" },
    ],
    pauseStatuses: { resolution: ["pending", "on_hold"], next_response: ["pending"] },
    ...overrides,
  });
}

export const at = (iso: string) => new Date(iso);

export const created = (iso: string, priority: "urgent" | "high" | "normal" | "low" | null = "high"): TicketEvent => ({
  type: "created",
  at: at(iso),
  priority,
  status: "new",
});
export const status = (iso: string, s: (TicketEvent & { type: "status_changed" })["status"]): TicketEvent => ({
  type: "status_changed",
  at: at(iso),
  status: s,
});
export const agentReply = (iso: string): TicketEvent => ({
  type: "comment",
  at: at(iso),
  author: "agent",
  public: true,
});
export const internalNote = (iso: string): TicketEvent => ({
  type: "comment",
  at: at(iso),
  author: "agent",
  public: false,
});
export const botReply = (iso: string): TicketEvent => ({ type: "comment", at: at(iso), author: "bot", public: true });
export const requesterReply = (iso: string): TicketEvent => ({
  type: "comment",
  at: at(iso),
  author: "requester",
  public: true,
});
export const priority = (iso: string, p: "urgent" | "high" | "normal" | "low" | null): TicketEvent => ({
  type: "priority_changed",
  at: at(iso),
  priority: p,
});
