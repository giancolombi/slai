import type { ContractText } from "@slai/shared";
import { Button, cn, Skeleton } from "@slai/ui";
import { Download, FileWarning } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useContractText } from "../../lib/queries";
import { findQuote, normalizeWithMap, type QuoteMatch, segment } from "./quote-match";
import type { Citation } from "./review-context";

export interface DocumentFocus {
  path: string;
  /** Changes on every request, so asking for the same passage twice scrolls again. */
  nonce: number;
}

export interface DocumentPaneProps {
  contractId: string;
  citations: Citation[];
  /** The field being hovered or focused: its quote is highlighted. */
  activePath: string | null;
  /** A citation the reviewer asked to see: scrolled into view and highlighted. */
  focus: DocumentFocus | null;
  /** Ambiguous paths still awaiting a decision (highlighted as warnings). */
  unresolved: Set<string>;
  label: (path: string) => string;
  onSelectPath: (path: string) => void;
  className?: string;
}

/** Jump instead of gliding when motion is reduced, or when the tab is hidden (smooth scrolls stall there). */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  (document.visibilityState === "hidden" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** Where each citation's quote sits in the text (null: not found). */
export function placeCitations(text: ContractText, citations: Citation[]) {
  const pages = text.pages.map((p) => ({ page: p.page, norm: normalizeWithMap(p.text) }));
  return new Map<string, QuoteMatch | null>(citations.map((c) => [c.path, findQuote(pages, c.quote, c.page)]));
}

/**
 * The contract's text beside the policy form. Cited passages are marked; the active
 * field's passage is highlighted, and a requested citation is scrolled to.
 */
export function DocumentPane(props: DocumentPaneProps) {
  const text = useContractText(props.contractId);
  if (text.isPending) {
    return (
      <div className={cn("flex flex-col gap-2 p-4", props.className)} role="status">
        <span className="sr-only">Loading the contract text…</span>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className={cn("h-3.5", i % 3 === 2 ? "w-2/3" : "w-full")} />
        ))}
      </div>
    );
  }
  if (text.isError) {
    return (
      <div className={cn("flex flex-col items-start gap-3 p-4 text-sm text-ink-muted", props.className)}>
        <p className="flex items-center gap-2">
          <FileWarning className="size-4 text-warning-text" aria-hidden />
          Couldn't show the contract text: {errorMessage(text.error)}
        </p>
        <Button asChild size="sm" leadingIcon={<Download />}>
          <a href={api.contracts.fileUrl(props.contractId)} target="_blank" rel="noreferrer">
            Open the original
          </a>
        </Button>
      </div>
    );
  }
  return <DocumentText {...props} text={text.data} />;
}

function DocumentText({
  text,
  citations,
  activePath,
  focus,
  unresolved,
  label,
  onSelectPath,
  className,
}: DocumentPaneProps & { text: ContractText }) {
  const scroller = useRef<HTMLElement>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [announce, setAnnounce] = useState("");
  const placed = useMemo(() => placeCitations(text, citations), [text, citations]);

  const byPage = useMemo(() => {
    const out = text.pages.map(() => [] as { path: string; start: number; end: number }[]);
    for (const [path, m] of placed) if (m) out[m.pageIndex]!.push({ path, start: m.start, end: m.end });
    return out;
  }, [text, placed]);

  const scrollTo = (path: string, mode: "center" | "nearest") => {
    const el = anchors.current.get(path);
    const box = scroller.current;
    if (!el || !box) return false;
    const top = el.offsetTop;
    const visible = top >= box.scrollTop + 24 && top + el.offsetHeight <= box.scrollTop + box.clientHeight - 24;
    if (mode === "nearest" && visible) return true;
    box.scrollTo({
      top: Math.max(0, top - box.clientHeight / 3),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    return true;
  };

  // A requested citation: scroll to it and say what happened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per request (nonce), not per render
  useEffect(() => {
    if (!focus) return;
    const m = placed.get(focus.path);
    if (m && scrollTo(focus.path, "center")) {
      const page = text.pages[m.pageIndex]?.page;
      setAnnounce(`Showing the quote for ${label(focus.path)}${page != null ? ` on page ${page}` : ""}.`);
    } else {
      setAnnounce(`The quote for ${label(focus.path)} isn't in the extracted text. Check the original document.`);
    }
  }, [focus?.nonce]);

  // Hovering or focusing a field brings its quote into view (only if it's off screen).
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the active field only
  useEffect(() => {
    if (activePath && placed.get(activePath)) scrollTo(activePath, "nearest");
  }, [activePath]);

  const missing = citations.filter((c) => !placed.get(c.path)).length;
  const focusMissing = focus && !placed.get(focus.path) ? focus.path : null;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {focusMissing && (
        <p className="mb-2 flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning-text">
          <FileWarning className="size-3.5 shrink-0" aria-hidden />
          The quote for {label(focusMissing)} isn't in the extracted text (it may span a page break). Check the
          original.
        </p>
      )}
      <section
        ref={scroller}
        aria-label={`Text of ${text.filename}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        className="relative overflow-y-auto rounded-md border border-line bg-surface px-4 py-3 scrollbar-thin focus-visible:outline-2 focus-visible:outline-accent lg:max-h-[calc(100dvh-15rem)]"
      >
        {text.pages.map((p, pageIndex) => {
          const segs = segment(p.text.length, byPage[pageIndex] ?? []);
          const seen = new Set<string>();
          return (
            <div key={p.page ?? "all"}>
              {p.page != null && (
                <h3 className="sticky top-0 z-[1] -mx-4 mb-1 border-b border-line bg-surface/95 px-4 py-1 font-mono text-2xs text-ink-subtle backdrop-blur-sm tnum">
                  Page {p.page}
                </h3>
              )}
              <p className="mb-4 font-serif text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                {segs.map((s) => {
                  const chunk = p.text.slice(s.start, s.end);
                  if (s.paths.length === 0) return <Fragment key={s.start}>{chunk}</Fragment>;
                  const active = activePath !== null && s.paths.includes(activePath);
                  const focused = focus !== null && s.paths.includes(focus.path);
                  const warn = s.paths.some((x) => unresolved.has(x));
                  const starts = s.paths.filter((x) => !seen.has(x));
                  for (const x of starts) seen.add(x);
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: a mouse shortcut; the citation list and field markers are the keyboard path
                    <mark
                      key={s.start}
                      ref={(el) => {
                        for (const x of starts) {
                          if (el) anchors.current.set(x, el);
                          else anchors.current.delete(x);
                        }
                      }}
                      data-paths={s.paths.join(" ")}
                      title={`Supports ${s.paths.map(label).join(", ")}`}
                      onClick={() => onSelectPath(s.paths[0]!)}
                      className={cn(
                        "cursor-pointer rounded-xs text-ink transition-[background-color,box-shadow] duration-[var(--duration-base)]",
                        "underline decoration-2 underline-offset-[3px]",
                        warn ? "bg-warning-subtle decoration-warning/70" : "bg-accent-subtle/55 decoration-accent/45",
                        (active || focused) && "bg-accent-subtle shadow-[0_0_0_2px_var(--color-accent)]",
                      )}
                    >
                      {chunk}
                    </mark>
                  );
                })}
              </p>
            </div>
          );
        })}
        {text.truncated && (
          <p className="border-t border-line pt-3 text-xs text-ink-muted">
            The text is cut here for length. The original has the rest.
          </p>
        )}
      </section>
      {missing > 0 && (
        <p className="mt-2 text-2xs text-ink-subtle">
          {missing} {missing === 1 ? "quote isn't" : "quotes aren't"} placed in the text (a page break or formatting
          splits {missing === 1 ? "it" : "them"}); see Citations.
        </p>
      )}
    </div>
  );
}
