/**
 * How engine values are stored in jsonb columns, shared by the worker (writer)
 * and the API (reader).
 *
 * - `tickets.evaluation` holds a StoredEvaluation: the engine's TicketEvaluation
 *   with Dates as ISO strings.
 * - `ticket_events` rows hold a canonical event: `type`, `at`, and `payload` =
 *   the CanonicalEvent's other fields (priority, status, author, public, ...).
 */
import type {
  CycleResult,
  MetricResult,
  Priority,
  TicketEvaluation,
  TicketEvent,
  TicketStatus,
} from "@slai/sla-engine";

type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type StoredCycle = Jsonify<CycleResult>;
export type StoredMetric = Jsonify<MetricResult>;
export type StoredEvaluation = Jsonify<TicketEvaluation>;

export function toStoredEvaluation(ev: TicketEvaluation): StoredEvaluation {
  return JSON.parse(JSON.stringify(ev)) as StoredEvaluation;
}

const d = (s: string | null) => (s === null ? null : new Date(s));

function cycleFromStored(c: StoredCycle): CycleResult {
  return { ...c, startedAt: new Date(c.startedAt), stoppedAt: d(c.stoppedAt), breachAt: d(c.breachAt) };
}

function metricFromStored(m: StoredMetric): MetricResult {
  return { ...m, dueAt: d(m.dueAt), cycles: m.cycles.map(cycleFromStored) };
}

export function fromStoredEvaluation(s: StoredEvaluation): TicketEvaluation {
  const metrics = s.metrics.map(metricFromStored);
  return {
    ...s,
    evaluatedAt: new Date(s.evaluatedAt),
    metrics,
    mostUrgent: s.mostUrgent ? (metrics.find((m) => m.metric === s.mostUrgent?.metric) ?? null) : null,
  };
}

export interface EventRow {
  type: string;
  at: Date;
  payload: unknown;
}

/** Maps stored ticket_events rows to the engine's events (non-SLA events are dropped). */
export function toEngineEvents(rows: EventRow[]): TicketEvent[] {
  const out: TicketEvent[] = [];
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    switch (r.type) {
      case "created":
        out.push({
          type: "created",
          at: r.at,
          priority: (p.priority as Priority | null) ?? null,
          status: p.status as TicketStatus,
        });
        break;
      case "priority_changed":
        out.push({ type: "priority_changed", at: r.at, priority: (p.priority as Priority | null) ?? null });
        break;
      case "status_changed":
        out.push({ type: "status_changed", at: r.at, status: p.status as TicketStatus });
        break;
      case "comment":
        out.push({
          type: "comment",
          at: r.at,
          author: p.author as "agent" | "requester" | "bot" | "system",
          public: p.public === true,
        });
        break;
    }
  }
  return out;
}
