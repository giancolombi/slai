import { CircleAlert } from "lucide-react";
import { Label as LabelPrimitive } from "radix-ui";
import { type ComponentPropsWithoutRef, createContext, forwardRef, type ReactNode, useContext, useId } from "react";
import { cn } from "../lib/cn";

export const Label = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(function Label(
  { className, ...props },
  ref,
) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn("text-sm font-medium text-ink select-none peer-disabled:opacity-60", className)}
      {...props}
    />
  );
});

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}
const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Wires the id, aria-describedby and aria-invalid of the control inside a Field.
 * Controls (Input, Textarea, SelectTrigger, ...) call this; explicit props win.
 */
export function useFieldControl<P extends { id?: string; "aria-describedby"?: string; "aria-invalid"?: unknown }>(
  props: P,
) {
  const field = useContext(FieldContext);
  if (!field) return props;
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-describedby": props["aria-describedby"] ?? field.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
    "aria-required": field.required || undefined,
  };
}

export interface FieldProps {
  label: ReactNode;
  /** Helper text below the control. */
  hint?: ReactNode;
  /** Error message; marks the control aria-invalid and is announced. */
  error?: ReactNode;
  required?: boolean;
  /** Put the label beside the control (checkbox/switch rows). */
  inline?: boolean;
  /** Optional right-aligned slot in the label row (e.g. "Forgot password?"). */
  labelAside?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  inline,
  labelAside,
  id,
  className,
  children,
}: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={cn(inline ? "flex items-start gap-3" : "flex flex-col gap-1.5", className)}>
        {inline ? (
          <>
            <div className="pt-0.5">{children}</div>
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={controlId}>{label}</Label>
              {hint && (
                <p id={hintId} className="text-xs text-ink-muted">
                  {hint}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={controlId}>
                {label}
                {required && (
                  <span className="ml-0.5 text-ink-subtle" aria-hidden>
                    *
                  </span>
                )}
              </Label>
              {labelAside}
            </div>
            {children}
            {hint && !error && (
              <p id={hintId} className="text-xs text-ink-muted">
                {hint}
              </p>
            )}
          </>
        )}
        {error && (
          <p id={errorId} role="alert" className="flex items-center gap-1 text-xs font-medium text-breached-text">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
