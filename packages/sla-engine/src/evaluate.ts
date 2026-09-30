import { addClockTime, clockTimeBetween } from "./calendar.js";
import {
  CLOSED_STATUSES,
  type CycleResult,
  METRICS,
  type Metric,
  type MetricResult,
  type Priority,
  type RiskLevel,
  type SlaPolicy,
  type SlaTarget,
  type TicketEvaluation,
  type TicketEvent,
  type TicketStatus,
} from "./types.js";

export class EvaluationError extends Error {}

interface Segment {
  start: number;
  end: number | null;
}

interface Cycle {
  metric: Metric;
  startedAt: number;
  stoppedAt: number | null;
  segments: Segment[];
  /** Priority in effect when the cycle stopped (targets for stopped cycles are frozen). */
  priorityAtStop: Priority | null;
  /** Set during finalization: the clock was running at the evaluation instant. */
  runningAtEnd?: boolean;
}

const RISK_ORDER: Record<RiskLevel, number> = { ok: 0, warning: 1, at_risk: 2, breached: 3 };

export function worstRisk(levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((w, r) => (RISK_ORDER[r] > RISK_ORDER[w] ? r : w), "ok");
}

function isClosed(s: TicketStatus): boolean {
  return CLOSED_STATUSES.includes(s);
}

/** Events at or before `now`, stably sorted by time. */
function prepare(events: TicketEvent[], now: Date): TicketEvent[] {
  const t = now.getTime();
  const sorted = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.at.getTime() <= t)
    .sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i)
    .map(({ e }) => e);
  const first = sorted[0];
  if (!first) throw new EvaluationError("ticket has no events at or before the evaluation time");
  if (first.type !== "created") throw new EvaluationError(`first event must be "created", got "${first.type}"`);
  if (sorted.slice(1).some((e) => e.type === "created")) {
    throw new EvaluationError('ticket has more than one "created" event');
  }
  return sorted;
}

/**
 * Replays the ticket history into measurement cycles.
 *
 * Rules (see specs/technical.md TR-4 to TR-8):
 * - first_response: starts at creation; stops at the first public agent reply
 *   (or bot reply when policy.botRepliesCount) or when the ticket is solved.
 * - next_response: after the first response, starts at a public requester
 *   comment when none is running; stops at the next public agent reply or solve.
 * - periodic_update: after the first response, (re)starts at every public agent
 *   reply; stops at solve; restarts on reopen.
 * - resolution: starts at creation; stops at solve; a reopen resumes the same
 *   cycle, so time accumulates across reopens.
 * - A metric's clock pauses while the status is in policy.pauseStatuses[metric].
 */
function replay(policy: SlaPolicy, events: TicketEvent[], nowMs: number) {
  const open = new Map<Metric, Cycle>();
  const done: Cycle[] = [];
  let status: TicketStatus = "new";
  let priority: Priority | null = null;
  let firstResponded = false;
  let requesterWaitingSince: number | null = null;

  const paused = (m: Metric, s: TicketStatus) => policy.pauseStatuses[m]?.includes(s) ?? false;

  const start = (m: Metric, t: number) => {
    if (open.has(m)) return;
    open.set(m, {
      metric: m,
      startedAt: t,
      stoppedAt: null,
      segments: paused(m, status) ? [] : [{ start: t, end: null }],
      priorityAtStop: null,
    });
  };

  const closeSegment = (c: Cycle, t: number) => {
    const last = c.segments.at(-1);
    if (last && last.end === null) last.end = t;
  };

  const stop = (m: Metric, t: number) => {
    const c = open.get(m);
    if (!c) return;
    closeSegment(c, t);
    c.stoppedAt = t;
    c.priorityAtStop = priority;
    done.push(c);
    open.delete(m);
  };

  const resumeResolution = (t: number) => {
    const idx = done.findLastIndex((c) => c.metric === "resolution");
    if (idx === -1) return start("resolution", t);
    const [c] = done.splice(idx, 1);
    if (!c) return;
    c.stoppedAt = null;
    c.priorityAtStop = null;
    if (!paused("resolution", status)) c.segments.push({ start: t, end: null });
    open.set("resolution", c);
  };

  for (const e of events) {
    const t = e.at.getTime();
    switch (e.type) {
      case "created":
        status = e.status;
        priority = e.priority;
        if (isClosed(status)) break;
        start("first_response", t);
        start("resolution", t);
        break;

      case "priority_changed":
        priority = e.priority;
        break;

      case "status_changed": {
        const prev: TicketStatus = status;
        status = e.status;
        if (prev === status) break;
        if (isClosed(status) && !isClosed(prev)) {
          for (const m of [...open.keys()]) stop(m, t);
          break;
        }
        if (!isClosed(status) && isClosed(prev)) {
          resumeResolution(t);
          if (firstResponded) start("periodic_update", t);
          if (firstResponded && requesterWaitingSince !== null) {
            start("next_response", requesterWaitingSince);
          }
          requesterWaitingSince = null;
          break;
        }
        for (const c of open.values()) {
          const was = paused(c.metric, prev);
          const is = paused(c.metric, status);
          if (!was && is) closeSegment(c, t);
          if (was && !is) c.segments.push({ start: t, end: null });
        }
        break;
      }

      case "comment": {
        if (!e.public) break;
        const agentish = e.author === "agent" || (e.author === "bot" && policy.botRepliesCount);
        if (agentish) {
          if (open.has("first_response")) {
            stop("first_response", t);
            firstResponded = true;
          }
          // A reply after a solve (without reopen) still counts as the first response happening.
          if (isClosed(status)) {
            firstResponded = true;
            break;
          }
          stop("next_response", t);
          stop("periodic_update", t);
          if (firstResponded) start("periodic_update", t);
        } else if (e.author === "requester") {
          if (!firstResponded) break;
          if (isClosed(status)) requesterWaitingSince = t;
          else start("next_response", t);
        }
        break;
      }
    }
  }

  for (const c of open.values()) {
    c.runningAtEnd = c.segments.at(-1)?.end === null;
    closeSegment(c, nowMs);
  }
  return { cycles: [...done, ...open.values()], status, priority };
}

function findTarget(policy: SlaPolicy, metric: Metric, p: Priority | null): SlaTarget | null {
  const eff = p ?? policy.defaultPriority;
  if (!eff) return null;
  return policy.targets.find((t) => t.metric === metric && t.priority === eff) ?? null;
}

function riskFor(consumed: number, breached: boolean, warnAt: number[]): RiskLevel {
  if (breached) return "breached";
  const [warn, atRisk] = warnAt;
  if (atRisk !== undefined && consumed >= atRisk) return "at_risk";
  if (warn !== undefined && consumed >= warn) return atRisk === undefined ? "at_risk" : "warning";
  return "ok";
}

function measureCycle(policy: SlaPolicy, c: Cycle, target: SlaTarget, nowMs: number): CycleResult {
  const targetMs = target.minutes * 60_000;
  let elapsed = 0;
  let breachAt: number | null = null;
  for (const s of c.segments) {
    const end = s.end ?? nowMs;
    const span = clockTimeBetween(new Date(s.start), new Date(end), policy.calendar, target.clock);
    if (breachAt === null && elapsed + span > targetMs) {
      breachAt = addClockTime(new Date(s.start), targetMs - elapsed, policy.calendar, target.clock).getTime();
    }
    elapsed += span;
  }
  const running = c.runningAtEnd === true;
  const breached = elapsed > targetMs;
  let state: CycleResult["state"];
  if (breached) state = "breached";
  else if (c.stoppedAt !== null) state = "achieved";
  else state = running ? "running" : "paused";
  if (!breached && running) {
    breachAt = addClockTime(new Date(nowMs), targetMs - elapsed, policy.calendar, target.clock).getTime();
  }
  return {
    startedAt: new Date(c.startedAt),
    stoppedAt: c.stoppedAt === null ? null : new Date(c.stoppedAt),
    elapsedMs: elapsed,
    targetMs,
    state,
    breachAt: breachAt === null ? null : new Date(breachAt),
  };
}

function notApplicable(metric: Metric, priority: Priority | null): MetricResult {
  return {
    metric,
    priority,
    state: "not_applicable",
    clock: null,
    targetMs: null,
    elapsedMs: 0,
    remainingMs: null,
    dueAt: null,
    consumed: null,
    risk: "ok",
    cycles: [],
    breachCount: 0,
  };
}

/** Evaluates every metric of `policy` for one ticket at instant `now`. */
export function evaluateTicket(policy: SlaPolicy, events: TicketEvent[], now: Date): TicketEvaluation {
  const nowMs = now.getTime();
  const { cycles, status, priority } = replay(policy, prepare(events, now), nowMs);

  const metrics: MetricResult[] = METRICS.map((metric) => {
    const mine = cycles.filter((c) => c.metric === metric).sort((a, b) => a.startedAt - b.startedAt);
    const results: CycleResult[] = [];
    let lastTarget: SlaTarget | null = null;
    for (const c of mine) {
      const target = findTarget(policy, metric, c.stoppedAt === null ? priority : c.priorityAtStop);
      if (!target) continue;
      results.push(measureCycle(policy, c, target, nowMs));
      lastTarget = target;
    }
    const current = results.at(-1);
    if (!current || !lastTarget) return notApplicable(metric, priority ?? policy.defaultPriority);

    const consumed = current.elapsedMs / current.targetMs;
    const live = current.state === "running" || current.state === "paused";
    return {
      metric,
      priority: priority ?? policy.defaultPriority,
      state: current.state,
      clock: lastTarget.clock,
      targetMs: current.targetMs,
      elapsedMs: current.elapsedMs,
      remainingMs: current.targetMs - current.elapsedMs,
      dueAt:
        current.state === "running" || (current.state === "breached" && current.stoppedAt === null)
          ? current.breachAt
          : null,
      consumed,
      risk:
        current.state === "achieved"
          ? "ok"
          : riskFor(consumed, current.state === "breached", live ? policy.warnAt : []),
      cycles: results,
      breachCount: results.filter((r) => r.state === "breached").length,
    };
  });

  const live = metrics.filter((m) => m.cycles.at(-1)?.stoppedAt === null && m.remainingMs !== null);
  const mostUrgent =
    live.sort((a, b) => {
      // Running clocks are more urgent than paused ones at equal remaining time.
      const ra = a.remainingMs ?? Number.POSITIVE_INFINITY;
      const rb = b.remainingMs ?? Number.POSITIVE_INFINITY;
      return ra - rb || (a.state === "running" ? -1 : 1);
    })[0] ?? null;

  return {
    policyId: policy.id,
    evaluatedAt: now,
    priority: priority ?? policy.defaultPriority,
    status,
    metrics,
    mostUrgent,
    risk: worstRisk(metrics.map((m) => m.risk)),
  };
}
