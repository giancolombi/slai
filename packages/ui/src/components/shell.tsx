import { Check, ChevronsUpDown, Menu, Plus } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type HTMLAttributes, type ReactNode, useState } from "react";
import { cn } from "../lib/cn";
import { IconButton } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./overlays";

// ---------------------------------------------------------------- Logo

/** The slai mark: a dial with a three-quarter sweep — time, measured. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6", className)} aria-hidden>
      <rect width="24" height="24" rx="6.5" fill="var(--accent)" />
      <circle cx="12" cy="12" r="6.25" fill="none" stroke="var(--on-accent)" strokeOpacity="0.28" strokeWidth="2" />
      <path
        d="M12 5.75a6.25 6.25 0 1 1-6.25 6.25"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M12 12V8.5" stroke="var(--on-accent)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.4" fill="var(--on-accent)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-[-0.03em] text-ink">slai</span>
    </span>
  );
}

// ---------------------------------------------------------------- Sidebar

export interface SidebarProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Sidebar({ header, footer, children, className }: SidebarProps) {
  return (
    <div className={cn("flex h-full w-full flex-col bg-canvas", className)}>
      {header && <div className="flex h-14 shrink-0 items-center px-4">{header}</div>}
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2.5 py-2 scrollbar-thin">
        {children}
      </nav>
      {footer && <div className="shrink-0 border-t border-line p-2.5">{footer}</div>}
    </div>
  );
}

export function SidebarSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {title && <p className="px-2 pb-1 text-2xs font-semibold tracking-wider text-ink-subtle uppercase">{title}</p>}
      <ul className="flex flex-col gap-px">{children}</ul>
    </div>
  );
}

/**
 * Class for a nav link. Active state follows `aria-current="page"` (or `data-status="active"`
 * from TanStack Router), so any router's Link can be styled with it.
 */
export const sidebarItemClass =
  "group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm font-medium text-ink-muted transition-colors " +
  "hover:bg-hover hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:shadow-sm " +
  "data-[status=active]:bg-surface data-[status=active]:text-ink data-[status=active]:shadow-sm " +
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-subtle aria-[current=page]:[&_svg]:text-accent data-[status=active]:[&_svg]:text-accent";

export function SidebarItemContent({ icon, label, badge }: { icon?: ReactNode; label: ReactNode; badge?: ReactNode }) {
  return (
    <>
      {icon}
      <span className="truncate">{label}</span>
      {badge !== undefined && badge !== null && badge !== 0 && (
        <span className="ml-auto inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-accent px-1 font-mono text-2xs font-semibold text-on-accent tnum">
          {badge}
        </span>
      )}
    </>
  );
}

// ---------------------------------------------------------------- App shell

export interface AppShellProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  children: ReactNode;
}

/**
 * Sidebar + top bar layout. At lg and up the sidebar is docked; below that it opens
 * as a drawer from the top bar's menu button (see `AppShellMenuButton`).
 */
export function AppShell({ sidebar, topBar, children }: AppShellProps) {
  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#main"
        className="sr-only z-[var(--z-toast)] rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-line lg:block">{sidebar}</aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {topBar}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppShellMenuButton({ sidebar }: { sidebar: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <IconButton label="Open navigation" icon={<Menu />} className="lg:hidden" />
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-[var(--overlay)] animate-fade-in lg:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-[var(--z-modal)] w-64 border-r border-line shadow-lg animate-fade-in lg:hidden"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          {sidebar}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function TopBar({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={cn(
        "sticky top-0 z-[var(--z-sticky)] flex h-14 shrink-0 items-center gap-2 border-b border-line bg-canvas/85 px-4 backdrop-blur-md md:px-6",
        className,
      )}
      {...props}
    >
      {children}
    </header>
  );
}

// ---------------------------------------------------------------- Org switcher

export interface OrgSwitcherProps {
  current: { id: string; name: string; plan?: string };
  organizations: { id: string; name: string; role?: string }[];
  onSwitch: (id: string) => void;
  onCreate?: () => void;
}

function OrgMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm bg-ink text-2xs font-bold text-ink-inverse"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function OrgSwitcher({ current, organizations, onSwitch, onCreate }: OrgSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 max-w-60 items-center gap-2 rounded-md px-1.5 text-sm font-medium text-ink hover:bg-hover"
          aria-label={`Organization: ${current.name}. Switch organization`}
        >
          <OrgMark name={current.name} />
          <span className="truncate">{current.name}</span>
          {current.plan && (
            <span className="hidden rounded-xs border border-line px-1 text-2xs font-medium text-ink-muted capitalize sm:inline">
              {current.plan}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-subtle" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {organizations.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => o.id !== current.id && onSwitch(o.id)}>
            <OrgMark name={o.name} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{o.name}</span>
              {o.role && <span className="text-2xs text-ink-muted capitalize">{o.role}</span>}
            </span>
            {o.id === current.id && <Check className="ml-auto text-accent-text!" aria-label="Current" />}
          </DropdownMenuItem>
        ))}
        {onCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCreate}>
              <Plus aria-hidden /> New organization
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- Page header

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small line above the title (breadcrumb or eyebrow). */
  eyebrow?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, eyebrow, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium text-ink-muted">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
