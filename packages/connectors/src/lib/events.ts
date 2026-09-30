/**
 * Helpers shared by every connector for turning a platform's history into the
 * canonical event stream.
 */
import type { AuthorRole, TicketEvent } from "@slai/sla-engine";
import type { CanonicalComment, CanonicalEvent } from "../types.js";

/**
 * Orders events by source timestamp; ties keep the order the connector
 * produced (which follows the platform's own sequence), and `created` always
 * comes first at its instant. Duplicate idempotency keys are dropped.
 */
export function finalizeEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  const seen = new Set<string>();
  return events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      if (seen.has(e.idempotencyKey)) return false;
      seen.add(e.idempotencyKey);
      return true;
    })
    .sort((a, b) => {
      const dt = a.e.at.getTime() - b.e.at.getTime();
      if (dt !== 0) return dt;
      if (a.e.type === "created") return -1;
      if (b.e.type === "created") return 1;
      return a.i - b.i;
    })
    .map(({ e }) => e);
}

/**
 * Collapses status/priority events that don't change anything (platforms often
 * log "set status to open" on an open ticket). Keeps the stream minimal and
 * makes the engine's replay easier to explain in a dispute.
 */
export function dropNoopChanges(events: CanonicalEvent[]): CanonicalEvent[] {
  let status: string | null = null;
  let priority: string | null | undefined;
  const out: CanonicalEvent[] = [];
  for (const e of events) {
    if (e.type === "created") {
      status = e.status;
      priority = e.priority;
    } else if (e.type === "status_changed") {
      if (e.status === status) continue;
      status = e.status;
    } else if (e.type === "priority_changed") {
      if (e.priority === priority) continue;
      priority = e.priority;
    }
    out.push(e);
  }
  return out;
}

/** Strips canonical events to what `evaluateTicket` consumes. */
export function toEngineEvents(events: CanonicalEvent[]): TicketEvent[] {
  const out: TicketEvent[] = [];
  for (const e of events) {
    switch (e.type) {
      case "created":
        out.push({ type: "created", at: e.at, priority: e.priority, status: e.status });
        break;
      case "priority_changed":
        out.push({ type: "priority_changed", at: e.at, priority: e.priority });
        break;
      case "status_changed":
        out.push({ type: "status_changed", at: e.at, status: e.status });
        break;
      case "comment":
        out.push({ type: "comment", at: e.at, author: e.author, public: e.public });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * The ticket's opening message never counts as a response, even when an agent
 * opened the ticket on a customer's behalf (vendors disagree here; we pick the
 * rule that never hides a missed first response). The comment keeps its true
 * author role; only the event's author becomes "system", which the engine
 * ignores for response metrics.
 */
export function openingEventAuthor(role: AuthorRole): AuthorRole {
  return role === "requester" ? "requester" : "system";
}

/**
 * First public agent reply, derived by us from comments (never trusted from
 * the vendor's own field). Bots count only when `botsCount`.
 */
export function firstPublicAgentReply(
  comments: CanonicalComment[],
  opts: { botsCount?: boolean; excludeSourceIds?: string[] } = {},
): CanonicalComment | null {
  const excluded = new Set(opts.excludeSourceIds ?? []);
  return (
    [...comments]
      .filter(
        (c) =>
          c.public &&
          !excluded.has(c.sourceId) &&
          (c.authorRole === "agent" || (opts.botsCount === true && c.authorRole === "bot")),
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null
  );
}

/** Parses a vendor timestamp; throws on garbage so bad data never becomes "now". */
export function parseTime(v: string | number | null | undefined, what: string): Date {
  if (v === null || v === undefined || v === "") throw new Error(`missing timestamp: ${what}`);
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`bad timestamp for ${what}: ${v}`);
  return d;
}

export function optTime(v: string | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
