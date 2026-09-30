import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Constrain height so the sticky header has something to stick in. */
  maxHeight?: string | number;
  /** Visually denser rows. */
  dense?: boolean;
  containerClassName?: string;
}

/** A table in a scroll container with a sticky header. Use a <caption> or aria-label to name it. */
export function Table({ className, containerClassName, maxHeight, dense, ...props }: TableProps) {
  return (
    <div
      className={cn("relative w-full overflow-auto scrollbar-thin", containerClassName)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      data-dense={dense || undefined}
    >
      <table className={cn("w-full border-separate border-spacing-0 text-sm group/table", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("sticky top-0 z-[var(--z-sticky)] bg-surface", className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&>tr:last-child>td]:border-b-0", className)} {...props} />;
}

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  interactive?: boolean;
  selected?: boolean;
}

export function TR({ className, interactive, selected, ...props }: TRProps) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        interactive && "cursor-pointer transition-colors hover:bg-hover",
        selected && "bg-accent-subtle/60",
        className,
      )}
      {...props}
    />
  );
}

export type SortDirection = "asc" | "desc" | null;

export interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Makes the header a sort button; the current direction drives aria-sort. */
  sortable?: boolean;
  sortDirection?: SortDirection;
  onSort?: () => void;
  align?: "left" | "right" | "center";
}

export function TH({ className, sortable, sortDirection = null, onSort, align = "left", children, ...props }: THProps) {
  const ariaSort = sortable
    ? sortDirection === "asc"
      ? "ascending"
      : sortDirection === "desc"
        ? "descending"
        : "none"
    : undefined;
  const Icon = sortDirection === "asc" ? ArrowUp : sortDirection === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn(
        "h-9 border-b border-line px-3 text-2xs font-semibold tracking-wide whitespace-nowrap text-ink-muted uppercase",
        "shadow-[0_1px_0_var(--line)]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded-xs px-1 py-0.5 uppercase hover:text-ink",
            sortDirection && "text-ink",
            align === "right" && "flex-row-reverse",
          )}
        >
          {children}
          <Icon className={cn("size-3", !sortDirection && "opacity-50")} aria-hidden />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: "left" | "right" | "center";
  /** Numbers: mono tabular figures. */
  numeric?: boolean;
}

export function TD({ className, align, numeric, ...props }: TDProps) {
  return (
    <td
      className={cn(
        "border-b border-line px-3 py-2.5 align-middle text-ink group-data-[dense]/table:py-1.5",
        (align === "right" || numeric) && "text-right",
        align === "center" && "text-center",
        numeric && "font-mono text-xs tnum",
        className,
      )}
      {...props}
    />
  );
}

/** A full-width row for empty/error/loading content inside a table body. */
export function TableMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        {children}
      </td>
    </tr>
  );
}
