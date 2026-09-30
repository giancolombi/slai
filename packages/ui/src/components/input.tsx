import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

/** Controls fill their container unless the caller sets a width. */
export function widthOr(className: string | undefined, fallback = "w-full") {
  return className && /(^|\s)(w-|min-w-|max-w-|flex-1|size-)/.test(className) ? undefined : fallback;
}

export const controlBase =
  "rounded-md border border-line-strong bg-surface text-ink shadow-xs " +
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)] " +
  "hover:border-ink-subtle/60 focus-visible:outline-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/20 " +
  "aria-invalid:border-breached aria-invalid:focus-visible:ring-breached/20 " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-muted";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Icon or text inside the left edge (e.g. a search icon). */
  leading?: ReactNode;
  /** Element inside the right edge (e.g. a unit or a clear button). */
  trailing?: ReactNode;
  inputSize?: "sm" | "md";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, inputSize = "md", ...rest },
  ref,
) {
  const props = useFieldControl(rest);
  const input = (
    <input
      ref={ref}
      className={cn(
        controlBase,
        leading || trailing ? "w-full" : widthOr(className),
        inputSize === "sm" ? "h-7 px-2 text-xs" : "h-8.5 px-3 text-sm",
        leading ? "pl-8" : undefined,
        trailing ? "pr-9" : undefined,
        props.type === "number" && "tnum",
        !leading && !trailing && className,
      )}
      {...props}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <div className={cn("relative flex items-center", widthOr(className), className)}>
      {leading && (
        <span className="pointer-events-none absolute left-2.5 flex text-ink-subtle [&_svg]:size-4">{leading}</span>
      )}
      {input}
      {trailing && <span className="absolute right-2 flex items-center text-xs text-ink-muted">{trailing}</span>}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  const props = useFieldControl(rest);
  return (
    <textarea
      ref={ref}
      className={cn(controlBase, widthOr(className), "min-h-20 resize-y px-3 py-2 text-sm leading-relaxed", className)}
      {...props}
    />
  );
});
