import { cn, Tooltip } from "@slai/ui";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

/** Short explanations of key concepts, shown by "What's this?" tooltips. */
export const CONCEPTS = {
  risk: {
    label: "risk",
    text: "Risk is the worst live SLA metric on the ticket: On track, Warning (past the first threshold, 50% by default), At risk (past the second, 80%), Breached (over the target).",
  },
  thresholds: {
    label: "SLA bar",
    text: "The bar shows how much of the target is used. The ticks are the policy's warning thresholds: crossing the first makes the metric Warning, the second At risk. Past 100% it breached.",
  },
  autonomy: {
    label: "autonomy levels",
    text: "Observe: alerts only. Assist: a draft for one-click approval (also posted as an internal note). Autopilot: sent automatically, but only if every guardrail passes.",
  },
  ambiguity: {
    label: "ambiguities",
    text: "Values the contract doesn't settle. slai made an assumption; confirm it or change the value. Approval stays blocked until every question is resolved.",
  },
  citations: {
    label: "citations",
    text: "The exact contract text each value came from, checked to appear in the document. A value without a verified quote becomes a question instead.",
  },
  tracked: {
    label: "tracked tickets",
    text: "A ticket counts once per calendar month (UTC) if any of its SLA clocks was live that month. Over the limit, monitoring never stops; the overage is billed.",
  },
} as const;

export type Concept = keyof typeof CONCEPTS;

/** A small "?" button with a tooltip explaining a concept. Keyboard focusable; the text is also its description. */
export function WhatsThis({
  concept,
  className,
  children,
}: {
  concept: Concept;
  className?: string;
  children?: ReactNode;
}) {
  const c = CONCEPTS[concept];
  return (
    <Tooltip content={children ?? c.text}>
      <button
        type="button"
        aria-label={`What's this? ${c.label}`}
        aria-description={c.text}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-ink-subtle hover:bg-hover hover:text-ink",
          className,
        )}
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}
