import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium select-none " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-out " +
  "disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:shrink-0";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent shadow-xs hover:bg-accent-hover",
  secondary: "bg-surface text-ink border border-line-strong shadow-xs hover:bg-hover hover:border-ink-subtle/40",
  ghost: "text-ink-muted hover:text-ink hover:bg-hover",
  danger: "bg-breached text-on-breached shadow-xs hover:brightness-95",
  link: "text-accent-text underline-offset-4 hover:underline px-0! h-auto!",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs rounded-sm [&_svg]:size-3.5",
  md: "h-8.5 px-3.5 text-sm rounded-md [&_svg]:size-4",
  lg: "h-10 px-4.5 text-base rounded-md [&_svg]:size-4.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Render the child element (e.g. a router Link) with button styles. */
  asChild?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    asChild = false,
    leadingIcon,
    trailingIcon,
    className,
    children,
    disabled,
    type,
    ...props
  },
  ref,
) {
  const classes = cn(base, variants[variant], sizes[size], className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "leadingIcon" | "trailingIcon" | "children"> {
  /** Required: icon-only controls need an accessible name. */
  label: string;
  icon: ReactNode;
}

const iconSizes: Record<ButtonSize, string> = {
  sm: "size-7 px-0!",
  md: "size-8.5 px-0!",
  lg: "size-10 px-0!",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", variant = "ghost", className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn(iconSizes[size], className)}
      {...props}
    >
      {icon}
    </Button>
  );
});
