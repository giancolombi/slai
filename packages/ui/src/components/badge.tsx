import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { RISK_META, type Risk } from "../lib/risk";

export type BadgeTone = "neutral" | "accent" | "ok" | "warning" | "at_risk" | "breached" | "outline";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-ink-muted border-line",
  accent: "bg-accent-subtle text-accent-text border-accent/20",
  ok: "bg-ok-subtle text-ok-text border-ok-border",
  warning: "bg-warning-subtle text-warning-text border-warning-border",
  at_risk: "bg-at-risk-subtle text-at-risk-text border-at-risk-border",
  breached: "bg-breached-subtle text-breached-text border-breached-border",
  outline: "bg-transparent text-ink-muted border-line-strong",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: "sm" | "md";
  icon?: ReactNode;
}

export function Badge({ tone = "neutral", size = "md", icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border font-medium whitespace-nowrap [&_svg]:shrink-0",
        size === "sm" ? "h-5 px-1.5 text-2xs [&_svg]:size-3" : "h-6 px-2 text-xs [&_svg]:size-3.5",
        tones[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}

export interface RiskBadgeProps extends Omit<BadgeProps, "tone" | "icon" | "children"> {
  risk: Risk;
  /** Hide the visible label (keeps an accessible name). Use only where a column header names it. */
  iconOnly?: boolean;
  /** Override the label, e.g. "Breached ×2". */
  label?: string;
}

/** Risk is always icon + label + color, never color alone. */
export function RiskBadge({ risk, iconOnly, label, size = "md", className, ...props }: RiskBadgeProps) {
  const meta = RISK_META[risk];
  const Icon = meta.icon;
  const text = label ?? meta.label;
  if (iconOnly) {
    return (
      <span
        role="img"
        aria-label={text}
        title={text}
        className={cn("inline-flex", meta.text, size === "sm" ? "[&_svg]:size-3.5" : "[&_svg]:size-4", className)}
        {...props}
      >
        <Icon aria-hidden strokeWidth={2.25} />
      </span>
    );
  }
  return (
    <Badge
      tone={risk}
      size={size}
      icon={<Icon aria-hidden strokeWidth={2.25} />}
      className={className}
      data-risk={risk}
      {...props}
    >
      {text}
    </Badge>
  );
}

/** A small solid dot for dense places (legends, list rows). Pair with text. */
export function RiskDot({ risk, pulse = false, className }: { risk: Risk; pulse?: boolean; className?: string }) {
  const meta = RISK_META[risk];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        meta.solid,
        meta.text,
        pulse && "animate-pulse-ring",
        className,
      )}
    />
  );
}
