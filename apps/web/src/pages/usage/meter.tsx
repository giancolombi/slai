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
  className?: string;
}

/** A quota meter (not an SLA): accent fill, warning past `warnAt`, breached at 100%. */
export function UsageMeter({ label, value, max, valueText, warnAt = 0.8, className }: UsageMeterProps) {
  const fraction = max ? value / max : 0;
  const tone = !max ? "bg-accent" : fraction >= 1 ? "bg-breached" : fraction >= warnAt ? "bg-warning" : "bg-accent";
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
      {max ? (
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-surface"
          style={{ left: `${warnAt * 100}%` }}
        />
      ) : null}
    </div>
  );
}
