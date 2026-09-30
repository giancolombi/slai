import { addClockTime } from "./calendar.js";
import type { SlaPolicy, TicketEvaluation } from "./types.js";

/**
 * The next instant at which this ticket's risk can change without any new
 * ticket event: the earliest future warn threshold or breach of a running
 * clock. Returns null when no clock is running (all stopped or paused). The
 * worker stores this as `next_check_at` and re-evaluates the ticket then.
 */
export function nextTransitionAt(policy: SlaPolicy, ev: TicketEvaluation): Date | null {
  const now = ev.evaluatedAt.getTime();
  let next: number | null = null;
  for (const m of ev.metrics) {
    if (m.state !== "running" || m.targetMs === null || m.clock === null) continue;
    for (const fraction of [...policy.warnAt, 1]) {
      const thresholdMs = Math.floor(m.targetMs * fraction);
      // Breach is strictly past the target, so check 1ms beyond it.
      const at = fraction === 1 ? thresholdMs + 1 : thresholdMs;
      if (at <= m.elapsedMs) continue;
      const t = addClockTime(ev.evaluatedAt, at - m.elapsedMs, policy.calendar, m.clock).getTime();
      if (t > now && (next === null || t < next)) next = t;
      break;
    }
  }
  return next === null ? null : new Date(next);
}
