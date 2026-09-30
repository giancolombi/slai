import { X } from "lucide-react";
import {
  Dialog as DialogPrimitive,
  DropdownMenu as MenuPrimitive,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

// ---------------------------------------------------------------- Tabs

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  function TabsList({ className, ...props }, ref) {
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn("flex items-center gap-1 border-b border-line overflow-x-auto scrollbar-thin", className)}
        {...props}
      />
    );
  },
);

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  function TabsTrigger({ className, ...props }, ref) {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          "relative -mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-sm font-medium whitespace-nowrap text-ink-muted",
          "transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink [&_svg]:size-4",
          className,
        )}
        {...props}
      />
    );
  },
);

export const TabsContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  function TabsContent({ className, ...props }, ref) {
    return <TabsPrimitive.Content ref={ref} className={cn("pt-4 focus-visible:outline-none", className)} {...props} />;
  },
);

// ---------------------------------------------------------------- Dialog

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element (rendered asChild). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer actions, right-aligned. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const dialogSizes = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size = "md",
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-[var(--overlay)] backdrop-blur-[2px] animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-[12vh] left-1/2 z-[var(--z-modal)] flex max-h-[76vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col",
            "rounded-xl border border-line bg-raised shadow-lg animate-pop-in focus:outline-none",
            dialogSizes[size],
          )}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
            <div>
              <DialogPrimitive.Title className="text-md font-semibold text-ink">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-sm text-ink-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="-mt-1 -mr-1 inline-flex size-7 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          {children && <div className="min-h-0 overflow-y-auto px-5 pb-5 scrollbar-thin">{children}</div>}
          {footer && (
            <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-sunken/40 px-5 py-3">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogClose = DialogPrimitive.Close;

// ---------------------------------------------------------------- Sheet (side drawer)

export interface SheetProps extends Omit<DialogProps, "size"> {
  side?: "right" | "left";
  width?: "sm" | "md" | "lg";
}

const sheetWidths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" };

export function Sheet({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  side = "right",
  width = "md",
}: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-[var(--overlay)] animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-y-0 z-[var(--z-modal)] flex w-full flex-col border-line bg-raised shadow-lg focus:outline-none",
            side === "right" ? "right-0 border-l animate-slide-in-right" : "left-0 border-r animate-fade-in",
            sheetWidths[width],
          )}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-md font-semibold text-ink">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-sm text-ink-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="inline-flex size-7 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------- DropdownMenu

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export const DropdownMenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof MenuPrimitive.Content>>(
  function DropdownMenuContent({ className, sideOffset = 6, align = "start", ...props }, ref) {
    return (
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          ref={ref}
          sideOffset={sideOffset}
          align={align}
          className={cn(
            "z-[var(--z-overlay)] min-w-48 overflow-hidden rounded-lg border border-line bg-raised p-1 shadow-lg animate-pop-in",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Portal>
    );
  },
);

const itemClass =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-ink outline-none select-none " +
  "data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-ink-muted";

export const DropdownMenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { destructive?: boolean; shortcut?: ReactNode }
>(function DropdownMenuItem({ className, destructive, shortcut, children, ...props }, ref) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(itemClass, destructive && "text-breached-text [&_svg]:text-breached-text", className)}
      {...props}
    >
      {props.asChild ? (
        children
      ) : (
        <>
          {children}
          {shortcut && <span className="ml-auto pl-4 font-mono text-2xs text-ink-subtle">{shortcut}</span>}
        </>
      )}
    </MenuPrimitive.Item>
  );
});

export const DropdownMenuRadioItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <MenuPrimitive.RadioItem ref={ref} className={cn(itemClass, "pr-7", className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-2 flex">
        <span className="size-1.5 rounded-full bg-accent" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
});

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn("px-2 pt-1.5 pb-1 text-2xs font-semibold text-ink-subtle uppercase tracking-wide", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

// ---------------------------------------------------------------- Tooltip

export const TooltipProvider = TooltipPrimitive.Provider;

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/** Wrap a focusable element. Tooltips supplement, never replace, a visible or accessible label. */
export function Tooltip({ content, children, side = "top", align = "center" }: TooltipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="z-[var(--z-tooltip)] max-w-72 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-snug text-ink-inverse shadow-md animate-fade-in"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-ink" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
