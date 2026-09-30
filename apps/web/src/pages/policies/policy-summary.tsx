import type { CreditAmount, SlaPolicy } from "@slai/sla-engine";
import { formatDuration, formatMoney } from "@slai/ui";
import { METRIC_LABEL, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL } from "../../lib/labels";
import { METRICS, WEEKDAY_LABEL, WEEKDAYS } from "../contracts/policy-paths";

function amount(a: CreditAmount) {
  return a.kind === "fixed_cents" ? formatMoney(a.cents) : `${a.percent}% of fee`;
}

/** Read-only digest of a policy definition. */
export function PolicySummary({ def }: { def: SlaPolicy }) {
  const days = WEEKDAYS.map((d) => ({ d, ranges: def.calendar.weekly[d] ?? [] }));
  return (
    <div className="flex flex-col gap-6 text-sm">
      <section aria-labelledby="ps-targets">
        <h3 id="ps-targets" className="mb-2 text-2xs font-semibold tracking-wide text-ink-muted uppercase">
          Targets
        </h3>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <caption className="sr-only">Targets by metric and priority</caption>
            <thead className="bg-sunken/60">
              <tr>
                <th scope="col" className="px-2.5 py-1.5 text-left font-medium text-ink-muted">
                  Metric
                </th>
                {PRIORITIES.map((p) => (
                  <th key={p} scope="col" className="px-2.5 py-1.5 text-right font-medium text-ink-muted">
                    {PRIORITY_LABEL[p]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m} className="border-t border-line">
                  <th scope="row" className="px-2.5 py-1.5 text-left font-medium text-ink">
                    {METRIC_LABEL[m]}
                  </th>
                  {PRIORITIES.map((p) => {
                    const t = def.targets.find((x) => x.metric === m && x.priority === p);
                    return (
                      <td key={p} className="px-2.5 py-1.5 text-right font-mono tnum">
                        {t ? (
                          <span title={t.clock === "business" ? "Business hours" : "Calendar (24×7)"}>
                            {formatDuration(t.minutes * 60_000)}
                            {t.clock === "calendar" && <span className="ml-1 text-2xs text-accent-text">24×7</span>}
                          </span>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="ps-cal">
        <h3 id="ps-cal" className="mb-2 text-2xs font-semibold tracking-wide text-ink-muted uppercase">
          Business calendar · {def.calendar.timezone.replace(/_/g, " ")}
        </h3>
        <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {days.map(({ d, ranges }) => (
            <li key={d} className="flex items-baseline justify-between gap-2 border-b border-line/60 py-0.5">
              <span className="text-ink-muted">{WEEKDAY_LABEL[d].slice(0, 3)}</span>
              <span className="font-mono text-xs text-ink tnum">
                {ranges.length === 0
                  ? "Closed"
                  : ranges
                      .map((r) => (r.start === "00:00" && r.end === "24:00" ? "24h" : `${r.start}–${r.end}`))
                      .join(", ")}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-muted">
          {def.calendar.holidays.length} {def.calendar.holidays.length === 1 ? "holiday" : "holidays"} · default
          priority {def.defaultPriority ? PRIORITY_LABEL[def.defaultPriority].toLowerCase() : "none (not measured)"} ·
          warns at {def.warnAt.map((w) => `${Math.round(w * 100)}%`).join(" and ")}
        </p>
      </section>

      <section aria-labelledby="ps-pauses">
        <h3 id="ps-pauses" className="mb-2 text-2xs font-semibold tracking-wide text-ink-muted uppercase">
          Pauses
        </h3>
        {METRICS.every((m) => !(def.pauseStatuses[m] ?? []).length) ? (
          <p className="text-ink-muted">No metric pauses; every clock runs in every open status.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {METRICS.filter((m) => (def.pauseStatuses[m] ?? []).length).map((m) => (
              <li key={m}>
                <span className="text-ink">{METRIC_LABEL[m]}</span>
                <span className="text-ink-muted"> pauses while </span>
                {(def.pauseStatuses[m] ?? []).map((s) => STATUS_LABEL[s].toLowerCase()).join(" or ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ps-credits">
        <h3 id="ps-credits" className="mb-2 text-2xs font-semibold tracking-wide text-ink-muted uppercase">
          Service credits
        </h3>
        {def.credits.length === 0 ? (
          <p className="text-ink-muted">None.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {def.credits.map((c) => {
              const scope =
                [c.metric ? METRIC_LABEL[c.metric] : null, c.priority ? PRIORITY_LABEL[c.priority] : null]
                  .filter(Boolean)
                  .join(" · ") || "All tickets";
              return (
                <li key={c.id} className="rounded-md border border-line px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">
                      {c.basis === "per_breach" ? "Per breach" : "Attainment"}
                    </span>
                    {c.sourceClause && <span className="font-mono text-2xs text-ink-muted">{c.sourceClause}</span>}
                  </div>
                  <p className="text-xs text-ink-muted">
                    {scope}
                    {" · "}
                    {c.basis === "per_breach"
                      ? `${amount(c.amount)} each`
                      : c.tiers.map((t) => `below ${t.belowPercent}% → ${amount(t.amount)}`).join("; ")}
                    {c.capPercent !== null && ` · capped at ${c.capPercent}% of fee`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
