import { Check, Pause, Timer } from "lucide-react";
import { cn } from "../lib/cn";
import { formatDuration, formatDurationLong } from "../lib/format";
import { RISK_META, type Risk } from "../lib/risk";
import { useNow } from "../lib/use-now";

export type ClockState = "running" | "paused" | "achieved" | "breached" | "not_applicable";

export interface SlaClockProps {
  /** When the running cycle breaches. Null while paused or not applicable. */
  dueAt: string | Date | null;
  /** The metric's state from the engine. Default "running". */
  state?: ClockState;
  /** Remaining ms reported by the API; shown frozen while paused. */
  remainingMs?: number | null;
  /** Server risk; colors the clock. Overdue clocks always read as breached. */
  risk?: Risk;
  size?: "sm" | "md" | "lg";
  /** Show the leading state icon. Default true. */
  showIcon?: boolean;
  /** Fixed "now" (epoch ms) for replays and tests; disables ticking. */
  now?: number;
  className?: string;
}

const sizes = {
  sm: "text-xs gap-1 [&_svg]:size-3",
  md: "text-sm gap-1.5 [&_svg]:size-3.5",
  lg: "text-3xl gap-2.5 font-medium tracking-tight [&_svg]:size-6",
};

/** Formats a remaining time for a ticking clock: seconds are shown under a day. */
export function formatClock(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= 24 * 3_600_000) return formatDuration(abs, { units: 3, smallest: "m", pad: true });
  return formatDuration(abs, { units: 3, smallest: "s", pad: true });
}

/**
 * A live countdown to `dueAt` in tabular mono. Ticks every second (one shared timer),
 * freezes while paused, and flips to an "overdue" count-up past the due time.
 */
export function SlaClock({
  dueAt,
  state = "running",
  remainingMs = null,
  risk,
  size = "md",
  showIcon = true,
  now: fixedNow,
  className,
}: SlaClockProps) {
  const ticking = state === "running" && dueAt !== null && fixedNow === undefined;
  const liveNow = useNow(ticking);
  const now = fixedNow ?? liveNow;

  let text: string;
  let label: string;
  let tone: string;
  let Icon = Timer;
  let suffix: string | null = null;

  if (state === "achieved") {
    text = "Met";
    label = "Target met";
    tone = RISK_META.ok.text;
    Icon = Check;
  } else if (state === "not_applicable") {
    text = "—";
    label = "Not measured";
    tone = "text-ink-subtle";
  } else if (state === "paused") {
    const left = remainingMs ?? 0;
    text = formatClock(left);
    label =
      left >= 0 ? `Paused with ${formatDurationLong(left)} left` : `Paused, overdue by ${formatDurationLong(left)}`;
    tone = "text-ink-muted";
    Icon = Pause;
    suffix = "paused";
  } else if (dueAt === null) {
    text = "—";
    label = "No due time";
    tone = "text-ink-subtle";
  } else {
    const left = new Date(dueAt).getTime() - now;
    if (left < 0 || state === "breached") {
      text = `+${formatClock(left)}`;
      label = `Overdue by ${formatDurationLong(left)}`;
      tone = RISK_META.breached.text;
      suffix = "overdue";
    } else {
      text = formatClock(left);
      label = `Due in ${formatDurationLong(left)}`;
      tone = risk ? RISK_META[risk].text : "text-ink";
    }
  }

  const dueIso = dueAt ? new Date(dueAt).toISOString() : undefined;
  return (
    <span
      role="timer"
      aria-label={label}
      data-state={state}
      className={cn("inline-flex items-center font-mono whitespace-nowrap tnum", sizes[size], tone, className)}
    >
      {showIcon && state !== "not_applicable" && <Icon aria-hidden className="shrink-0 opacity-80" />}
      <time dateTime={dueIso} aria-hidden>
        {text}
      </time>
      {suffix && size !== "sm" && (
        <span
          aria-hidden
          className={cn(
            "font-sans font-medium opacity-80",
            size === "lg" ? "text-sm" : "text-2xs uppercase tracking-wide",
          )}
        >
          {suffix}
        </span>
      )}
    </span>
  );
}
