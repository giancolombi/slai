/**
 * Canonical domain types for the SLA engine.
 *
 * The engine is pure and deterministic: given a policy, a ticket's event
 * history and an evaluation instant, it always returns the same result. No I/O,
 * no clocks read implicitly, no LLM. Every connector maps its platform's ticket
 * history into `TicketEvent`s; every policy (human-authored or extracted from a
 * contract and approved by a human) is validated into `SlaPolicy`.
 */

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Normalized ticket status. Connectors map platform statuses onto these.
 * - `pending`: waiting on the requester (customer).
 * - `on_hold`: waiting on a third party / internal team.
 */
export const STATUSES = ["new", "open", "pending", "on_hold", "solved", "closed"] as const;
export type TicketStatus = (typeof STATUSES)[number];

export const CLOSED_STATUSES: readonly TicketStatus[] = ["solved", "closed"];

export type AuthorRole = "agent" | "requester" | "bot" | "system";

export type TicketEvent =
  | { type: "created"; at: Date; priority: Priority | null; status: TicketStatus }
  | { type: "priority_changed"; at: Date; priority: Priority | null }
  | { type: "status_changed"; at: Date; status: TicketStatus }
  | { type: "comment"; at: Date; author: AuthorRole; public: boolean };

export const METRICS = ["first_response", "next_response", "periodic_update", "resolution"] as const;
export type Metric = (typeof METRICS)[number];

export type ClockKind = "business" | "calendar";

/** "HH:mm" 24h local time. "24:00" is allowed as an end of day. */
export type LocalTime = string;

export interface TimeRange {
  start: LocalTime;
  end: LocalTime;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface BusinessCalendar {
  /** IANA zone, e.g. "America/New_York". */
  timezone: string;
  /** Working ranges per weekday. A missing or empty day is a non-working day. */
  weekly: Partial<Record<Weekday, TimeRange[]>>;
  /** Full-day non-working dates, "YYYY-MM-DD" in the calendar's zone. */
  holidays: string[];
}

export interface SlaTarget {
  metric: Metric;
  priority: Priority;
  /** Target duration in minutes of the chosen clock. */
  minutes: number;
  clock: ClockKind;
}

export interface SlaPolicy {
  id: string;
  name: string;
  calendar: BusinessCalendar;
  targets: SlaTarget[];
  /**
   * Priority assumed while a ticket has none. `null` means tickets without a
   * priority are not measured until one is set.
   */
  defaultPriority: Priority | null;
  /**
   * Statuses that pause each metric's clock. Typical contracts pause
   * resolution while waiting on the customer; first response is rarely paused.
   */
  pauseStatuses: Partial<Record<Metric, TicketStatus[]>>;
  /** Whether replies from bots/automations satisfy a response metric. */
  botRepliesCount: boolean;
  /** Warn thresholds as fractions of the target consumed, ascending. */
  warnAt: number[];
  /** Service-credit terms from the contract; drives dollar exposure. */
  credits: CreditRule[];
}

/**
 * A service-credit clause. `per_breach` credits accrue per breached cycle;
 * `attainment` credits apply when the period's attainment % falls below a tier.
 */
export type CreditRule =
  | {
      id: string;
      basis: "per_breach";
      metric: Metric | null;
      priority: Priority | null;
      amount: CreditAmount;
      /** Max credit per period as % of the period fee. */
      capPercent: number | null;
      sourceClause: string | null;
    }
  | {
      id: string;
      basis: "attainment";
      metric: Metric | null;
      priority: Priority | null;
      /** Ordered from mildest to harshest; the harshest matching tier applies. */
      tiers: { belowPercent: number; amount: CreditAmount }[];
      capPercent: number | null;
      sourceClause: string | null;
    };

export type CreditAmount = { kind: "fixed_cents"; cents: number } | { kind: "percent_of_fee"; percent: number };

export type MetricState =
  /** Clock running now. */
  | "running"
  /** Clock started but paused by status. */
  | "paused"
  /** Stop condition met within target. */
  | "achieved"
  /** Target exceeded (whether or not the stop condition was later met). */
  | "breached"
  /** No target for this metric/priority, or the metric never started. */
  | "not_applicable";

export type RiskLevel = "ok" | "warning" | "at_risk" | "breached";

export interface CycleResult {
  /** When this measurement cycle started. */
  startedAt: Date;
  /** When the stop condition was met, if it has been. */
  stoppedAt: Date | null;
  elapsedMs: number;
  targetMs: number;
  state: Exclude<MetricState, "not_applicable">;
  /** Wall-clock instant the target is (or was) crossed, if known. */
  breachAt: Date | null;
}

export interface MetricResult {
  metric: Metric;
  priority: Priority | null;
  state: MetricState;
  clock: ClockKind | null;
  targetMs: number | null;
  /** Elapsed clock time for the current (latest) cycle. */
  elapsedMs: number;
  /** Target minus elapsed; negative once breached. Null when not applicable. */
  remainingMs: number | null;
  /** Wall-clock instant the current cycle breaches if nothing changes. */
  dueAt: Date | null;
  /** Fraction of target consumed by the current cycle (0..∞). */
  consumed: number | null;
  risk: RiskLevel;
  /** Every cycle so far (next_response/periodic_update have many). */
  cycles: CycleResult[];
  breachCount: number;
}

export interface TicketEvaluation {
  policyId: string;
  evaluatedAt: Date;
  priority: Priority | null;
  status: TicketStatus;
  metrics: MetricResult[];
  /** The live metric closest to breaching (or already breached and still open). */
  mostUrgent: MetricResult | null;
  risk: RiskLevel;
}
