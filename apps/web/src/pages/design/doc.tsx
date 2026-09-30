import { cn } from "@slai/ui";
import type { ReactNode } from "react";

/** Building blocks for the living style guide. */

export function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 border-t border-line pt-10 pb-4 first:border-t-0 first:pt-0"
    >
      <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight text-ink">
        {title}
      </h2>
      {lead && <p className="mt-2 max-w-3xl text-sm text-ink-muted">{lead}</p>}
      <div className="mt-6 flex flex-col gap-8">{children}</div>
    </section>
  );
}

export function Example({
  title,
  description,
  children,
  code,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  code?: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="mt-0.5 max-w-3xl text-sm text-ink-muted">{description}</p>}
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className={cn("flex flex-wrap items-center gap-3 p-5", className)}>{children}</div>
        {code && (
          <pre className="overflow-x-auto border-t border-line bg-sunken/60 px-5 py-3 font-mono text-xs leading-relaxed text-ink-muted scrollbar-thin">
            <code>{code.trim()}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function TokenTable({ rows, head }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface scrollbar-thin">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b border-line px-4 py-2 text-left text-2xs font-semibold tracking-wide whitespace-nowrap text-ink-muted uppercase"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static documentation rows
            <tr key={i} className="[&:last-child>td]:border-b-0">
              {r.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static documentation cells
                <td key={j} className="border-b border-line px-4 py-2.5 align-middle text-ink">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-xs bg-sunken px-1 py-0.5 font-mono text-xs text-ink">{children}</code>;
}

export function Swatch({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="h-12 rounded-md border border-line shadow-xs" style={{ background: value }} />
      <div className="font-mono text-2xs leading-tight text-ink-muted">{label}</div>
    </div>
  );
}
