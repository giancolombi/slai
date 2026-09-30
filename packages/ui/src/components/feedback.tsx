import { Avatar as AvatarPrimitive } from "radix-ui";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/** A shimmering placeholder. Give it the size of what it stands in for. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn(
        "rounded-sm bg-[linear-gradient(90deg,var(--sunken)_0%,var(--hover-tint)_50%,var(--sunken)_100%)] bg-[length:200%_100%] bg-sunken animate-shimmer",
        className,
      )}
    />
  );
}

/** Rows of skeleton lines with an sr-only loading announcement. */
export function SkeletonRows({
  rows = 5,
  className,
  label = "Loading",
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)} role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
          <Skeleton className="ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** "error" tints the icon and uses role=alert. */
  tone?: "neutral" | "error";
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  compact,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
      {...props}
    >
      {icon && (
        <div
          className={cn(
            "flex items-center justify-center rounded-xl border [&_svg]:size-5",
            compact ? "size-9" : "size-11",
            tone === "error"
              ? "border-breached-border bg-breached-subtle text-breached-text"
              : "border-line bg-sunken text-ink-muted",
          )}
        >
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description && <p className="text-sm text-ink-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line: a delta, a comparison or context. */
  detail?: ReactNode;
  /** Tone for the detail line. */
  detailTone?: "neutral" | "good" | "bad";
  icon?: ReactNode;
  /** A trend graphic (usually a Sparkline). */
  trend?: ReactNode;
  className?: string;
}

/** A KPI tile: label, a large tabular number, a detail line, optional sparkline. */
export function Stat({ label, value, detail, detailTone = "neutral", icon, trend, className }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-xs", className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="font-mono text-2xl font-medium tracking-tight text-ink tnum">{value}</div>
        {trend && <div className="mb-1 shrink-0">{trend}</div>}
      </div>
      {detail && (
        <div
          className={cn(
            "text-xs",
            detailTone === "good" && "text-ok-text",
            detailTone === "bad" && "text-breached-text",
            detailTone === "neutral" && "text-ink-muted",
          )}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

export interface AvatarProps {
  name: string | null | undefined;
  src?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const avatarSizes = { xs: "size-5 text-[9px]", sm: "size-6 text-2xs", md: "size-8 text-xs", lg: "size-10 text-sm" };

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/** Deterministic hue per name so the same person keeps the same tint. */
function hueFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, src, size = "sm", className }: AvatarProps) {
  const label = name ?? "Unknown";
  const hue = hueFor(label);
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none",
        avatarSizes[size],
        className,
      )}
      style={{
        background: `color-mix(in oklab, oklch(0.7 0.1 ${hue}) 24%, var(--surface))`,
        color: `color-mix(in oklab, oklch(0.6 0.13 ${hue}) 55%, var(--text))`,
      }}
      title={label}
    >
      {src && <AvatarPrimitive.Image src={src} alt={label} className="size-full object-cover" />}
      <AvatarPrimitive.Fallback aria-label={label}>{name ? initials(name) : "?"}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

/** Keyboard key hint. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-strong border-b-2 bg-surface px-1 font-mono text-2xs font-medium text-ink-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export interface ProgressProps {
  /** 0–100. Omit for indeterminate. */
  value?: number;
  label: string;
  className?: string;
}

export function Progress({ value, label, className }: ProgressProps) {
  const indeterminate = value === undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-sunken", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-[var(--duration-slow)] ease-out",
          indeterminate &&
            "w-1/3 animate-shimmer bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] bg-[length:200%_100%]",
        )}
        style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}
