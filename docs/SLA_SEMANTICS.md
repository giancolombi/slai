# SLA semantics

This is exactly what `@slai/sla-engine` measures. When a customer disputes a breach, this
page, the policy version, and the ticket's event timeline are the explanation.

## Metrics

| Metric | Starts | Stops | Cycles |
|---|---|---|---|
| `first_response` | ticket created | first **public** reply by an agent (or a bot, if `botRepliesCount`); or solve | one |
| `next_response` | a public requester comment, **after** the first response, when no cycle is running | next public agent reply; or solve | many |
| `periodic_update` | the first response, then every public agent reply; also on reopen | next public agent reply; or solve | many |
| `resolution` | ticket created | solve/close. **A reopen resumes the same cycle**, so time accumulates | one |

- Internal notes never count as responses.
- A customer comment on a solved ticket starts `next_response` from the comment time only
  if the ticket is reopened. Otherwise nothing runs.
- Events are ordered by their **source timestamp**; ties keep delivery order. Evaluation at
  instant `now` ignores later events, so any past moment can be replayed exactly.

## Clocks

- `calendar`: wall-clock time, 24x7.
- `business`: only time inside the policy calendar's weekly hours, in its IANA time zone,
  minus holidays. Each local day uses its own hours, so DST shifts are handled.
- A metric's clock **pauses** while the ticket status is in `pauseStatuses[metric]`.
  Typical contracts pause resolution in `pending` (waiting on the customer) and `on_hold`.

## Priority and targets

- The target comes from `(metric, priority)`. A ticket without a priority uses
  `defaultPriority`. If that is null, the metric is not measured.
- A **running** cycle is judged against the **current** priority, with elapsed time
  carried over. A **stopped** cycle is frozen at the priority in effect when it stopped.

## Outcomes and risk

- A cycle is **breached** once elapsed > target (strictly). `breachAt` is the instant it
  crossed. A late reply does not undo a breach.
- `dueAt` is when the running cycle will breach if nothing changes. It is null while
  paused, because it depends on when the clock resumes.
- Risk per live metric: `warning` at `warnAt[0]` of the target consumed, `at_risk` at
  `warnAt[1]`, `breached` past it. The ticket's risk is the worst across metrics.

## Money

- **Attainment** = met cycles / (met + breached cycles) for a metric/priority scope in a
  period.
- **Credits**: `per_breach` rules accrue per breached cycle. `attainment` rules apply the
  harshest tier whose `belowPercent` the attainment falls under. Both can be capped as a
  percentage of the period fee.
