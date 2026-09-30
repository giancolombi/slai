import { type Metric, parsePolicy, type TicketEvaluation } from "@slai/sla-engine";

const ALL_WEEK = { start: "00:00", end: "24:00" };

/** A 24x7 calendar-clock policy, so end-to-end expectations are easy to reason about. */
export function calendarPolicy(overrides: Record<string, unknown> = {}) {
  const t = (metric: Metric, minutes: Record<string, number>) =>
    Object.entries(minutes).map(([priority, m]) => ({ metric, priority, minutes: m, clock: "calendar" }));
  return parsePolicy({
    id: "pol_test",
    name: "Test 24x7",
    calendar: {
      timezone: "UTC",
      weekly: {
        mon: [ALL_WEEK],
        tue: [ALL_WEEK],
        wed: [ALL_WEEK],
        thu: [ALL_WEEK],
        fri: [ALL_WEEK],
        sat: [ALL_WEEK],
        sun: [ALL_WEEK],
      },
      holidays: [],
    },
    defaultPriority: "normal",
    targets: [
      ...t("first_response", { urgent: 30, high: 60, normal: 240, low: 480 }),
      ...t("next_response", { urgent: 60, high: 120, normal: 480, low: 960 }),
      ...t("resolution", { urgent: 480, high: 1440, normal: 2880, low: 5760 }),
    ],
    pauseStatuses: { resolution: ["pending", "on_hold"], next_response: ["pending"] },
    ...overrides,
  });
}

export function metric(ev: TicketEvaluation, m: Metric) {
  const r = ev.metrics.find((x) => x.metric === m);
  if (!r) throw new Error(`no metric ${m}`);
  return r;
}
