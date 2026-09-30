import { CircleHelp, FileText, Link2 } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "../lib/cn";

export interface CitationQuoteProps {
  /** The verbatim contract text. */
  quote: string;
  /** Source document name. */
  document: string;
  page?: number | null;
  /** The policy field this quote supports, e.g. "First response · Urgent". */
  fieldLabel?: string;
  /** Highlight (e.g. while the linked field is focused). */
  active?: boolean;
  /** An ambiguity: the extractor was unsure about this clause. */
  ambiguous?: boolean;
  /** Jump to the linked field. Renders the field chip as a button. */
  onSelect?: () => void;
  className?: string;
}

/**
 * A contract quote linked to a policy field. The evidence for a number:
 * every value in an extracted policy should have one.
 */
export const CitationQuote = forwardRef<HTMLElement, CitationQuoteProps>(function CitationQuote(
  { quote, document, page, fieldLabel, active, ambiguous, onSelect, className },
  ref,
) {
  return (
    <figure
      ref={ref}
      data-active={active || undefined}
      className={cn(
        "group relative rounded-md border bg-surface py-2.5 pr-3 pl-4 transition-[border-color,box-shadow,background-color] duration-[var(--duration-base)]",
        "before:absolute before:inset-y-2 before:left-1.5 before:w-0.5 before:rounded-full",
        ambiguous ? "border-warning-border before:bg-warning" : "border-line before:bg-accent/60",
        active && "border-accent bg-accent-subtle/50 shadow-sm before:bg-accent",
        className,
      )}
    >
      <blockquote className="font-serif text-[14px] leading-relaxed text-ink">“{quote}”</blockquote>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <FileText className="size-3" aria-hidden />
          <cite className="not-italic">{document}</cite>
          {page != null && <span className="font-mono tnum">· p.{page}</span>}
        </span>
        {ambiguous && (
          <span className="inline-flex items-center gap-1 font-medium text-warning-text">
            <CircleHelp className="size-3" aria-hidden />
            Needs review
          </span>
        )}
        {fieldLabel &&
          (onSelect ? (
            <button
              type="button"
              onClick={onSelect}
              className="ml-auto inline-flex items-center gap-1 rounded-xs font-medium text-accent-text hover:underline"
            >
              <Link2 className="size-3" aria-hidden />
              {fieldLabel}
            </button>
          ) : (
            <span className="ml-auto inline-flex items-center gap-1 font-medium text-accent-text">
              <Link2 className="size-3" aria-hidden />
              {fieldLabel}
            </span>
          ))}
      </figcaption>
    </figure>
  );
});
