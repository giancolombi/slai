import { cn } from "@slai/ui";

export interface UsageMeterProps {
  label: string;
  value: number;
  /** Null means unlimited: the bar shows no fill limit. */
  max: number | null;
  /** Spoken value, e.g. "$612 of $1,500". */
  valueText: string;
  /** Fraction at which the bar turns to warning. Default 0.8. */
  warnAt?: number;
  /** Where the tick mark sits, as a fraction of `max` (e.g. the spend cap). Defaults to `warnAt`. */
  markAt?: number | null;
  /** What the tick mark means, shown on hover. */
  markLabel?: string;
  /** Fraction at which the bar turns to breached. Default 1. */
  breachAt?: number;
  className?: string;
}

/** A quota meter (not an SLA): accent fill, warning past `warnAt`, breached past `breachAt`. */
export function UsageMeter({
  label,
  value,
  max,
  valueText,
  warnAt = 0.8,
  markAt,
  markLabel,
  breachAt = 1,
  className,
}: UsageMeterProps) {
  const fraction = max ? value / max : 0;
  const tone = !max
    ? "bg-accent"
    : fraction >= breachAt
      ? "bg-breached"
      : fraction >= warnAt
        ? "bg-warning"
        : "bg-accent";
  const mark = markAt === undefined ? warnAt : markAt;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> can't be styled consistently across browsers
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max ?? undefined}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-sunken", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-[var(--duration-slow)] ease-out", tone)}
        style={{ width: max ? `${Math.min(fraction, 1) * 100}%` : "0%" }}
      />
      {max && mark !== null && mark > 0 && mark < 1 ? (
        <span
          aria-hidden
          title={markLabel}
          className={cn("absolute inset-y-0 w-0.5 -translate-x-1/2", markAt === undefined ? "bg-surface" : "bg-ink/70")}
          style={{ left: `${mark * 100}%` }}
        />
      ) : null}
    </div>
  );
}
