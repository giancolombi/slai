import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { interactive?: boolean }>(
  function Card({ className, interactive, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border border-line bg-surface shadow-xs",
          interactive && "transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-sm",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions. */
  actions?: ReactNode;
  /** Heading level for the title. Default h2. */
  as?: "h2" | "h3" | "h4";
}

export function CardHeader({
  title,
  description,
  actions,
  as: H = "h2",
  className,
  children,
  ...props
}: CardHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-4 pb-3", className)} {...props}>
      <div className="min-w-0">
        {title && <H className="text-sm font-semibold text-ink">{title}</H>}
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-line px-5 py-3 bg-sunken/40 rounded-b-lg",
        className,
      )}
      {...props}
    />
  );
}
