/**
 * Pure billing presentation rules (T-65): what the plan and state mean in plain
 * words, when the app shell shows a billing banner, and meter fractions. The
 * numbers themselves come from `GET /billing` (BillingSummary); nothing here
 * decides entitlements.
 */
import {
  type AgentCeiling,
  type BillingState,
  type BillingSummary,
  PLANS,
  type PlanId,
  TRIAL,
} from "@slai/shared";
import { formatMoney } from "@slai/ui";

export const CEILING_LABEL: Record<AgentCeiling, string> = {
  observe: "Observe",
  triage: "Triage",
  assist: "Assist",
  autopilot: "Autopilot",
};

/** What agents may do at each ceiling, in plain words. */
export const CEILING_HELP: Record<AgentCeiling, string> = {
  observe: "Agents only watch: SLA monitoring and alerts, no agent runs.",
  triage: "Agents triage tickets (category, priority, summary). No drafts.",
  assist: "Agents triage and draft replies for a person to approve. No autopilot.",
  autopilot: "Agents triage, draft, and send guarded autopilot replies.",
};

export type NoticeTone = "accent" | "warning" | "breached" | "neutral" | "ok";

export const STATE_META: Record<BillingState, { label: string; tone: NoticeTone }> = {
  trialing: { label: "Trial", tone: "accent" },
  trial_expired: { label: "Trial ended", tone: "breached" },
  active: { label: "Active", tone: "ok" },
  past_due: { label: "Payment past due", tone: "warning" },
  degraded: { label: "Observe only", tone: "breached" },
  canceled: { label: "Canceled", tone: "neutral" },
};

export function planName(id: PlanId | string): string {
  return (PLANS as Record<string, { name: string }>)[id]?.name ?? id;
}

/** "$999/mo", "Free", or "Custom" (Enterprise). */
export function planPrice(id: PlanId): string {
  const cents = PLANS[id].priceCents;
  if (cents === null) return "Custom";
  if (cents === 0) return "Free";
  return `${usd(cents)}/mo`;
}

/** Whole dollars when round, otherwise to the cent ($0.20 per ticket). */
export function usd(cents: number): string {
  return formatMoney(cents, cents % 100 === 0 ? "whole" : "exact");
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function days(n: number) {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

export interface BillingNotice {
  tone: NoticeTone;
  title: string;
  message: string;
}

/**
 * The billing notice for the billing page: every state that limits agents or
 * needs action gets one. Active plans get none.
 */
export function billingNotice(
  b: Pick<BillingSummary, "state" | "plan" | "trialDaysLeft" | "graceEndsAt">,
): BillingNotice | null {
  switch (b.state) {
    case "trialing": {
      const left = b.trialDaysLeft ?? 0;
      return {
        tone: left <= TRIAL.warnDaysBefore ? "warning" : "accent",
        title: `${days(left)} left in your ${planName(b.plan)} trial`,
        message: "Autopilot is off during the trial. Choose a plan to keep drafts and unlock autopilot.",
      };
    }
    case "trial_expired":
      return {
        tone: "breached",
        title: "Your trial has ended",
        message: "Agents are observe-only until you choose a plan. SLA monitoring and alerts continue.",
      };
    case "past_due":
      return {
        tone: "warning",
        title: "Payment past due",
        message: b.graceEndsAt
          ? `Update your payment method by ${dayFmt.format(new Date(b.graceEndsAt))} or agents step down to observe-only.`
          : "Update your payment method or agents step down to observe-only.",
      };
    case "degraded":
      return {
        tone: "breached",
        title: "Payment past due: agents are observe-only",
        message: "Update your payment method to restore your plan. SLA monitoring and alerts continue.",
      };
    case "canceled":
      return {
        tone: "neutral",
        title: "Subscription canceled",
        message: "Agents are observe-only. SLA monitoring and alerts continue. Choose a plan to restart.",
      };
    default:
      return null;
  }
}

/**
 * The slim app-shell banner: only when it needs attention soon (a trial within
 * TRIAL.warnDaysBefore days of ending, an ended trial, or a payment problem).
 */
export function shellBanner(
  b: Pick<BillingSummary, "state" | "plan" | "trialDaysLeft" | "graceEndsAt">,
): BillingNotice | null {
  if (b.state === "trialing" && (b.trialDaysLeft ?? 0) > TRIAL.warnDaysBefore) return null;
  if (b.state === "active" || b.state === "canceled") return null;
  return billingNotice(b);
}

/** A per-session dismissal key: dismissing hides this banner until the state or day count changes. */
export function bannerKey(b: Pick<BillingSummary, "state" | "trialDaysLeft">): string {
  return `slai-billing-banner:${b.state}:${b.trialDaysLeft ?? ""}`;
}

/** The fraction of `max` used, 0 when there is no limit. Never negative. */
export function fraction(value: number, max: number | null): number {
  if (!max || max <= 0) return 0;
  return Math.max(0, value / max);
}

/** Credits available before overage: included plus purchased. */
export function prepaidCredits(c: BillingSummary["credits"]): number {
  return c.included + c.purchasedAvailable;
}
