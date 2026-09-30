import { Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(
  function Checkbox({ className, ...rest }, ref) {
    const props = useFieldControl(rest);
    return (
      <CheckboxPrimitive.Root
        ref={ref}
        className={cn(
          "peer inline-flex size-4 shrink-0 items-center justify-center rounded-xs border border-line-strong bg-surface shadow-xs",
          "transition-colors duration-[var(--duration-fast)] hover:border-ink-subtle",
          "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent",
          "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-on-accent",
          "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-breached",
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator className="flex">
          {props.checked === "indeterminate" ? (
            <Minus className="size-3" strokeWidth={3} aria-hidden />
          ) : (
            <Check className="size-3" strokeWidth={3} aria-hidden />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    );
  },
);

export const Switch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(
  function Switch({ className, ...rest }, ref) {
    const props = useFieldControl(rest);
    return (
      <SwitchPrimitive.Root
        ref={ref}
        className={cn(
          "peer inline-flex h-5 w-8.5 shrink-0 items-center rounded-full border border-transparent bg-line-strong p-0.5",
          "transition-colors duration-[var(--duration-base)] data-[state=checked]:bg-accent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            "pointer-events-none block size-3.5 rounded-full bg-white shadow-sm",
            "transition-transform duration-[var(--duration-base)] ease-out data-[state=checked]:translate-x-3.5",
          )}
        />
      </SwitchPrimitive.Root>
    );
  },
);
