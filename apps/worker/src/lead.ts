/**
 * How much warning slai would have given before a breach: breachAt minus the
 * first instant the cycle was at_risk. Found by stepping the engine through
 * the only instants risk can change (event times and `nextTransitionAt`), so
 * pauses, business hours and priority changes are all accounted for.
 */
import {
  type CycleResult,
  evaluateTicket,
  type Metric,
  nextTransitionAt,
  type RiskLevel,
  type SlaPolicy,
  type TicketEvent,
} from "@slai/sla-engine";

const RANK: Record<RiskLevel, number> = { ok: 0, warning: 1, at_risk: 2, breached: 3 };
const MAX_STEPS = 1000;

export function warningLeadMs(
  policy: SlaPolicy,
  events: TicketEvent[],
  metric: Metric,
  cycle: CycleResult,
): number | null {
  if (cycle.state !== "breached" || !cycle.breachAt) return null;
  const start = cycle.startedAt.getTime();
  const breach = cycle.breachAt.getTime();
  const times = [...new Set(events.map((e) => e.at.getTime()))].sort((a, b) => a - b);
  let t = start;
  for (let i = 0; i < MAX_STEPS && t <= breach; i++) {
    const ev = evaluateTicket(policy, events, new Date(t));
    const m = ev.metrics.find((x) => x.metric === metric);
    const current = m?.cycles.at(-1);
    if (m && current && current.startedAt.getTime() === start && RANK[m.risk] >= RANK.at_risk) {
      return Math.max(0, breach - t);
    }
    const nextTimer = nextTransitionAt(policy, ev)?.getTime() ?? Number.POSITIVE_INFINITY;
    const nextEvent = times.find((x) => x > t) ?? Number.POSITIVE_INFINITY;
    const next = Math.min(nextTimer, nextEvent);
    if (!Number.isFinite(next)) break;
    t = next;
  }
  return 0;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
