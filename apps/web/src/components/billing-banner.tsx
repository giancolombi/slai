import { cn, IconButton } from "@slai/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, Clock, X } from "lucide-react";
import { useState } from "react";
import { bannerKey, type NoticeTone, shellBanner } from "../lib/billing";
import { useBilling } from "../lib/queries";

export const NOTICE_CLASS: Record<NoticeTone, string> = {
  accent: "border-accent/20 bg-accent-subtle text-accent-text",
  warning: "border-warning-border bg-warning-subtle text-warning-text",
  breached: "border-breached-border bg-breached-subtle text-breached-text",
  neutral: "border-line bg-sunken text-ink-muted",
  ok: "border-ok-border bg-ok-subtle text-ok-text",
};

function isDismissed(key: string) {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * A slim bar under the top bar when billing needs attention soon: the trial's
 * last days, an ended trial, or a payment problem. Dismissible for the session;
 * hidden on the billing page itself (which shows the full notice).
 */
export function BillingBanner() {
  const billing = useBilling();
  const onBilling = useRouterState({ select: (s) => s.location.pathname === "/billing" });
  const [hidden, setHidden] = useState<string | null>(null);
  if (!billing.data || onBilling) return null;
  const notice = shellBanner(billing.data);
  if (!notice) return null;
  const key = bannerKey(billing.data);
  if (hidden === key || isDismissed(key)) return null;
  const Icon = billing.data.state === "trialing" ? Clock : AlertTriangle;
  return (
    <section
      aria-label="Billing"
      className={cn("flex items-center gap-2.5 border-b px-4 py-1.5 text-sm md:px-6", NOTICE_CLASS[notice.tone])}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">{notice.title}.</span>{" "}
        <span className="hidden text-ink-muted sm:inline">{notice.message}</span>
      </p>
      <Link to="/billing" className="shrink-0 font-medium underline underline-offset-2">
        View billing
      </Link>
      <IconButton
        size="sm"
        label="Dismiss for this session"
        icon={<X />}
        onClick={() => {
          try {
            sessionStorage.setItem(key, "1");
          } catch {
            /* storage unavailable: hide until reload */
          }
          setHidden(key);
        }}
      />
    </section>
  );
}
