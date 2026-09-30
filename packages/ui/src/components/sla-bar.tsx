import { cn } from "../lib/cn";
import { RISK_META, type Risk, riskForFraction } from "../lib/risk";

export interface SlaBarProps {
  /** Elapsed clock time for the current cycle (ms). */
  elapsedMs: number;
  /** Target (ms). Null or 0 renders an empty, unmeasured bar. */
  targetMs: number | null;
  /** Warn thresholds as fractions of the target, ascending. Default [0.5, 0.8]. */
  warnAt?: readonly number[];
  /** Server risk. When omitted, risk is derived from the thresholds for display. */
  risk?: Risk;
  /** Accessible name, e.g. "First response". */
  label: string;
  /** Show the % consumed and threshold captions. */
  showScale?: boolean;
  paused?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/**
 * The fraction of the target consumed, with tick marks at the warn thresholds.
 * Past 100% the bar is full and a hatched overflow cap shows how far over it is.
 */
export function SlaBar({
  elapsedMs,
  targetMs,
  warnAt = [0.5, 0.8],
  risk,
  label,
  showScale = false,
  paused = false,
  size = "md",
  className,
}: SlaBarProps) {
  const measured = targetMs !== null && targetMs > 0;
  const consumed = measured ? elapsedMs / targetMs : 0;
  const shownRisk = risk ?? riskForFraction(consumed, warnAt);
  const meta = RISK_META[shownRisk];
  const pct = Math.round(consumed * 100);
  const over = consumed > 1;
  const valueText = measured
    ? `${pct}% of target used, ${meta.label.toLowerCase()}${paused ? ", paused" : ""}`
    : "Not measured";

  return (
    <div className={cn("flex w-full flex-col gap-1", className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot draw threshold ticks or an overflow cap */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
        aria-valuetext={valueText}
        data-risk={measured ? shownRisk : undefined}
        className={cn("relative w-full overflow-hidden rounded-full bg-sunken", size === "sm" ? "h-1.5" : "h-2")}
      >
        {measured && (
          <div
            data-part="fill"
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width] duration-[var(--duration-slow)] ease-out",
              meta.solid,
              paused && "opacity-50",
            )}
            style={{ width: `${Math.min(consumed, 1) * 100}%` }}
          />
        )}
        {over && (
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-1/5 bg-[repeating-linear-gradient(-45deg,transparent_0_3px,rgb(255_255_255/0.45)_3px_5px)]"
          />
        )}
        {warnAt.map((t) => (
          <span
            key={t}
            data-part="threshold"
            aria-hidden
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-surface"
            style={{ left: `${t * 100}%` }}
          />
        ))}
      </div>
      {showScale && (
        <div className="relative flex h-4 items-center text-2xs text-ink-muted" aria-hidden>
          <span className={cn("font-mono tnum", over && "font-semibold text-breached-text")}>
            {measured ? `${pct}%` : "—"}
          </span>
          {warnAt.map((t) => (
            <span
              key={t}
              className="absolute -translate-x-1/2 font-mono text-ink-subtle tnum"
              style={{ left: `${t * 100}%` }}
            >
              {Math.round(t * 100)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
