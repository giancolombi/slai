import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";
import { controlBase } from "./input";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Plain-text label for the trigger when `label` is rich. */
  textValue?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** An accessible single-select built on Radix Select (typeahead, keyboard, portal). */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  size = "md",
  disabled,
  name,
  className,
  ...rest
}: SelectProps) {
  const control = useFieldControl(rest);
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled} name={name}>
      <SelectPrimitive.Trigger
        {...control}
        className={cn(
          controlBase,
          "inline-flex items-center justify-between gap-2 text-left data-[placeholder]:text-ink-subtle",
          size === "sm" ? "h-7 px-2 text-xs" : "h-8.5 px-3 text-sm",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate [&_svg]:size-4">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 shrink-0 text-ink-subtle" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-[var(--z-overlay)] max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-raised shadow-lg animate-pop-in"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                textValue={o.textValue}
                className="relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm text-ink outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4"
              >
                {o.icon}
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex text-accent-text">
                  <Check aria-hidden />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
