import { CircleAlert, CircleCheck, type LucideIcon, OctagonX, TriangleAlert } from "lucide-react";

export type Risk = "ok" | "warning" | "at_risk" | "breached";
export const RISKS: readonly Risk[] = ["ok", "warning", "at_risk", "breached"];

export interface RiskMeta {
  label: string;
  /** Longer phrasing for tooltips and screen readers. */
  description: string;
  icon: LucideIcon;
  /** Tailwind classes for text, subtle background, border and solid marks. */
  text: string;
  subtle: string;
  border: string;
  solid: string;
}

export const RISK_META: Record<Risk, RiskMeta> = {
  ok: {
    label: "On track",
    description: "Less than the first warning threshold of the target is used.",
    icon: CircleCheck,
    text: "text-ok-text",
    subtle: "bg-ok-subtle",
    border: "border-ok-border",
    solid: "bg-ok",
  },
  warning: {
    label: "Warning",
    description: "Past the first warning threshold of the target.",
    icon: CircleAlert,
    text: "text-warning-text",
    subtle: "bg-warning-subtle",
    border: "border-warning-border",
    solid: "bg-warning",
  },
  at_risk: {
    label: "At risk",
    description: "Past the second warning threshold; a breach is close.",
    icon: TriangleAlert,
    text: "text-at-risk-text",
    subtle: "bg-at-risk-subtle",
    border: "border-at-risk-border",
    solid: "bg-at-risk",
  },
  breached: {
    label: "Breached",
    description: "The target was exceeded.",
    icon: OctagonX,
    text: "text-breached-text",
    subtle: "bg-breached-subtle",
    border: "border-breached-border",
    solid: "bg-breached",
  },
};

export const RISK_ORDER: Record<Risk, number> = { ok: 0, warning: 1, at_risk: 2, breached: 3 };

/**
 * Display-only risk for a fraction of target consumed, mirroring the engine's thresholds:
 * warning at warnAt[0], at_risk at warnAt[1], breached strictly past the target.
 * The authoritative risk always comes from @slai/sla-engine via the API.
 */
export function riskForFraction(consumed: number, warnAt: readonly number[] = [0.5, 0.8]): Risk {
  if (consumed > 1) return "breached";
  if (warnAt[1] !== undefined && consumed >= warnAt[1]) return "at_risk";
  if (warnAt[0] !== undefined && consumed >= warnAt[0]) return "warning";
  return "ok";
}
