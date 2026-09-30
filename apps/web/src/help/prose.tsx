/**
 * Building blocks for help guides: real headings (h2/h3 under the page's h1),
 * readable prose and callouts, in the slai design tokens.
 */
import { cn } from "@slai/ui";
import { Link } from "@tanstack/react-router";
import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { GuideId } from "./types";

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-20">
      <h2 id={id} className="mt-8 mb-2 text-lg font-semibold tracking-tight text-ink first:mt-0">
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function H3({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mt-3 scroll-mt-20 text-sm font-semibold text-ink">
      {children}
    </h3>
  );
}

export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm leading-relaxed text-ink-muted", className)}>{children}</p>;
}

export function Ul({ children }: { children: ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-muted marker:text-ink-subtle">
      {children}
    </ul>
  );
}

export function Ol({ children }: { children: ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink-muted marker:font-mono marker:text-ink-subtle">
      {children}
    </ol>
  );
}

/** Emphasis for a product term or on-screen label. */
export function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warning";
  title?: string;
  children: ReactNode;
}) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border p-3.5",
        tone === "warning" ? "border-warning-border bg-warning-subtle/60" : "border-line bg-sunken/60",
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", tone === "warning" ? "text-warning-text" : "text-accent-text")}
        aria-hidden
      />
      <div className="flex min-w-0 flex-col gap-1 text-sm leading-relaxed text-ink-muted">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** A link to another guide (optionally to a section in it). */
export function GuideLink({ to, anchor, children }: { to: GuideId; anchor?: string; children: ReactNode }) {
  return (
    <Link
      to="/help/$guideId"
      params={{ guideId: to }}
      hash={anchor}
      className="font-medium text-accent-text underline-offset-4 hover:underline"
    >
      {children}
    </Link>
  );
}

/** A link to a product page, for "where to do it". */
export function AppLink({ to, hash, children }: { to: string; hash?: string; children: ReactNode }) {
  return (
    <Link to={to} hash={hash} className="font-medium text-accent-text underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

/** A two-column definition table (term → meaning). */
export function Defs({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
      {rows.map(([term, def], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static content
        <div key={i} className="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-sm font-medium text-ink">{term}</dt>
          <dd className="text-sm leading-relaxed text-ink-muted">{def}</dd>
        </div>
      ))}
    </dl>
  );
}
