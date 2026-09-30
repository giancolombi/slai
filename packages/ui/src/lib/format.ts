const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = [
  { ms: DAY, short: "d", long: "day" },
  { ms: HOUR, short: "h", long: "hour" },
  { ms: MINUTE, short: "m", long: "minute" },
  { ms: SECOND, short: "s", long: "second" },
] as const;

export interface DurationFormatOptions {
  /** How many units to show, largest first. Default 2 ("1h 12m", "3d 4h"). */
  units?: number;
  /** Smallest unit to show. Default "m" (seconds only when the whole value is under a minute). */
  smallest?: "d" | "h" | "m" | "s";
  /** Pad every unit after the first to two digits ("1h 02m 05s"). Useful for ticking clocks. */
  pad?: boolean;
}

/**
 * Formats a duration in ms as "1h 12m", "3d 4h", "42s". Uses the absolute value;
 * callers add sign or "overdue" wording. Truncates (never rounds up) so a clock never
 * shows more time left than there is.
 */
export function formatDuration(ms: number, options: DurationFormatOptions = {}): string {
  const { units = 2, pad = false } = options;
  let abs = Math.abs(ms);
  const smallest = options.smallest ?? (abs < MINUTE ? "s" : "m");
  const smallestIndex = UNITS.findIndex((u) => u.short === smallest);
  const parts: string[] = [];
  for (let i = 0; i <= smallestIndex && parts.length < units; i++) {
    const unit = UNITS[i]!;
    const value = Math.floor(abs / unit.ms);
    abs -= value * unit.ms;
    if (value === 0 && parts.length === 0 && i < smallestIndex) continue;
    const text = pad && parts.length > 0 ? String(value).padStart(2, "0") : String(value);
    parts.push(`${text}${unit.short}`);
  }
  // "2h 0m" reads better as "2h" (clocks keep their fixed width instead).
  while (!pad && parts.length > 1 && /^0\D/.test(parts[parts.length - 1]!)) parts.pop();
  return parts.length ? parts.join(" ") : `0${smallest}`;
}

/** A screen-reader phrasing of a duration at minute resolution: "1 hour 12 minutes". */
export function formatDurationLong(ms: number): string {
  let abs = Math.abs(ms);
  if (abs < MINUTE) return "less than a minute";
  const parts: string[] = [];
  for (const unit of UNITS.slice(0, 3)) {
    const value = Math.floor(abs / unit.ms);
    abs -= value * unit.ms;
    if (value > 0) parts.push(`${value} ${unit.long}${value === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Money is integer cents on the wire. `whole` drops cents; `compact` gives "$12.4K". */
export function formatMoney(cents: number, mode: "exact" | "whole" | "compact" = "whole"): string {
  const dollars = cents / 100;
  if (mode === "compact" && Math.abs(dollars) >= 10_000) return usdCompact.format(dollars);
  if (mode === "exact") return usd.format(dollars);
  return usdWhole.format(dollars);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

const intFmt = new Intl.NumberFormat("en-US");
export function formatNumber(value: number): string {
  return intFmt.format(value);
}

const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
/** "3 minutes ago", "in 2 hours". */
export function formatRelative(date: string | Date, now: number = Date.now()): string {
  const diff = new Date(date).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "just now";
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), "day");
  return formatDate(date);
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function formatDate(date: string | Date): string {
  return dateFmt.format(new Date(date));
}
export function formatDateTime(date: string | Date): string {
  return dateTimeFmt.format(new Date(date));
}
export function formatTime(date: string | Date): string {
  return timeFmt.format(new Date(date));
}
