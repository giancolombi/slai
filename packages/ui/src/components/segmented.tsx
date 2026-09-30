import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
}

export interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedOption[];
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
}

/** A single-choice toggle group (arrow keys move between options). */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  ...rest
}: SegmentedControlProps) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v)}
      aria-label={rest["aria-label"]}
      className={cn("inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm font-medium whitespace-nowrap text-ink-muted transition-colors hover:text-ink",
            "data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-sm [&_svg]:size-3.5",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-sm",
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
