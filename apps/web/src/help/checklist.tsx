import type { OnboardingState, OnboardingStepId } from "@slai/shared";
import { Badge, Button, Card, cn, Progress } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, X } from "lucide-react";
import type { GuideId } from "./types";

export interface StepMeta {
  title: string;
  /** One line: why this step matters. */
  why: string;
  cta: { label: string; to: string; hash?: string };
  guide: GuideId;
}

/** What each derived step means to a newcomer, and where to do it. */
export const STEP_META: Record<OnboardingStepId, StepMeta> = {
  connect: {
    title: "Connect a help desk",
    why: "slai reads your tickets and their history to run every SLA clock.",
    cta: { label: "Connect", to: "/connections" },
    guide: "connections",
  },
  contract: {
    title: "Upload a contract",
    why: "Your SLA terms come from the contract, with a citation for every number.",
    cta: { label: "Upload", to: "/contracts" },
    guide: "contract-review",
  },
  policy: {
    title: "Approve a policy",
    why: "Nothing is measured until an admin approves a policy from a contract, or a default policy.",
    cta: { label: "Review", to: "/contracts" },
    guide: "contract-review",
  },
  assign: {
    title: "Assign policies to customers",
    why: "Each customer's tickets run on their own contract; a default policy covers the rest.",
    cta: { label: "Assign", to: "/customers" },
    guide: "contract-review",
  },
  autonomy: {
    title: "Choose autonomy",
    why: "Decide whether agents only alert, draft for your approval, or reply on their own.",
    cta: { label: "Choose", to: "/autonomy" },
    guide: "autonomy",
  },
  alerts: {
    title: "Set up alerts",
    why: "Hear about risk in email or Slack before a ticket breaches, not after.",
    cta: { label: "Add a channel", to: "/settings", hash: "notifications" },
    guide: "alerts",
  },
  invite: {
    title: "Invite a teammate",
    why: "Share the approvals inbox with your leads. slai prices by tickets, not seats.",
    cta: { label: "Invite", to: "/team" },
    guide: "team-security",
  },
  replay: {
    title: "Run a Breach Replay",
    why: "See the last 90 days through your contracts, priced in service credits.",
    cta: { label: "Replay", to: "/replay" },
    guide: "replay",
  },
};

export interface ChecklistProps {
  state: OnboardingState;
  /** Hide from the dashboard (persisted per user). Omitted where the checklist can't be dismissed. */
  onDismiss?: () => void;
  dismissing?: boolean;
  /** Admins and owners do the steps; others see where things stand. */
  canAct: boolean;
  className?: string;
}

/** The getting-started checklist: steps derived from real org state, each with a why and a CTA. */
export function Checklist({ state, onDismiss, dismissing, canAct, className }: ChecklistProps) {
  const next = state.steps.find((s) => !s.done && !s.optional) ?? state.steps.find((s) => !s.done);
  const pct = (state.requiredDone / state.requiredTotal) * 100;
  return (
    <Card className={className}>
      <section aria-labelledby="checklist-title">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 id="checklist-title" className="text-sm font-semibold text-ink">
              Get started with slai
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {state.requiredDone === state.requiredTotal
                ? "Setup is done: every ticket is measured and someone hears about risk in time."
                : "Each step ticks off by itself as it really happens. About five minutes in all."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-ink-muted tnum" aria-hidden>
              {state.requiredDone}/{state.requiredTotal}
            </span>
            {onDismiss && (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<X aria-hidden />}
                onClick={onDismiss}
                loading={dismissing}
                title="Hide the checklist. Bring it back from Help."
              >
                Hide
              </Button>
            )}
          </div>
        </div>
        <div className="px-5 pb-3">
          <Progress value={pct} label={`${state.requiredDone} of ${state.requiredTotal} setup steps done`} />
        </div>
        <ol className="flex flex-col border-t border-line">
          {state.steps.map((s, i) => {
            const meta = STEP_META[s.id];
            const isNext = next?.id === s.id;
            return (
              <li
                key={s.id}
                data-step={s.id}
                data-done={s.done || undefined}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3 last:border-b-0",
                  isNext && "bg-accent-subtle/40",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-2xs font-semibold tnum",
                    s.done
                      ? "border-ok-border bg-ok-subtle text-ok-text"
                      : isNext
                        ? "border-accent bg-accent text-on-accent"
                        : "border-line-strong text-ink-muted",
                  )}
                  aria-hidden
                >
                  {s.done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1 basis-60">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <span className={cn(s.done && "text-ink-muted line-through decoration-ink-subtle")}>
                      {meta.title}
                    </span>
                    <span className="sr-only">{s.done ? "(done)" : "(to do)"}</span>
                    {s.optional && (
                      <Badge size="sm" tone="outline">
                        Optional
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-ink-muted">{meta.why}</p>
                </div>
                {s.done ? (
                  <span className="text-xs font-medium text-ok-text">Done</span>
                ) : canAct ? (
                  <Button asChild size="sm" variant={isNext ? "primary" : "secondary"}>
                    <Link to={meta.cta.to} hash={meta.cta.hash} aria-label={`${meta.cta.label}: ${meta.title}`}>
                      {meta.cta.label} <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                ) : (
                  <Link
                    to="/help/$guideId"
                    params={{ guideId: meta.guide }}
                    className="text-xs font-medium text-accent-text hover:underline"
                  >
                    Learn how
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
        {!canAct && (
          <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
            Owners and admins complete these steps. You'll see them tick off as they do.
          </p>
        )}
      </section>
    </Card>
  );
}
