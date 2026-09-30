import {
  AppShell,
  AppShellMenuButton,
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Kbd,
  Logo,
  OrgSwitcher,
  Sidebar,
  SidebarItemContent,
  SidebarSection,
  sidebarItemClass,
  ThemeToggle,
  TopBar,
  toast,
} from "@slai/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import {
  BookOpen,
  Bot,
  Building2,
  Cable,
  CircleHelp,
  FileSignature,
  Gauge,
  History,
  Inbox,
  KeyRound,
  LogOut,
  Palette,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Ticket,
  Users,
} from "lucide-react";
import { type FormEvent, useEffect, useRef } from "react";
import { BillingBanner } from "./components/billing-banner";
import { LiveIndicator } from "./components/live-indicator";
import { PageHelpButton } from "./help/help-panel";
import { WelcomeDialog } from "./help/welcome";
import { api, errorMessage } from "./lib/api";
import { useLiveUpdates } from "./lib/live";
import { useActions, useContracts, useMe } from "./lib/queries";

export const MOCK_MODE = import.meta.env.VITE_MOCK_API === "1";

function Nav() {
  const approvals = useActions("proposed");
  const contracts = useContracts();
  const pending = approvals.data?.items.length ?? 0;
  const review = contracts.data?.items.filter((c) => c.status === "needs_review").length ?? 0;
  const item = (to: string, icon: React.ReactNode, label: string, badge?: number, exact = false) => (
    <li>
      <Link to={to} className={sidebarItemClass} activeOptions={{ exact }}>
        <SidebarItemContent icon={icon} label={label} badge={badge} />
      </Link>
    </li>
  );
  return (
    <Sidebar
      header={
        <Link to="/" aria-label="slai home" className="rounded-sm">
          <Logo />
        </Link>
      }
      footer={
        <ul>
          <li>
            <Link to="/help" className={sidebarItemClass}>
              <SidebarItemContent icon={<CircleHelp />} label="Help" />
            </Link>
          </li>
          <li>
            <Link to="/design" className={sidebarItemClass}>
              <SidebarItemContent icon={<Palette />} label="Design system" />
            </Link>
          </li>
        </ul>
      }
    >
      <SidebarSection title="Operate">
        {item("/", <Gauge />, "Dashboard", undefined, true)}
        {item("/tickets", <Ticket />, "Tickets")}
        {item("/approvals", <Inbox />, "Approvals", pending)}
      </SidebarSection>
      <SidebarSection title="Contracts">
        {item("/contracts", <FileSignature />, "Contracts", review)}
        {item("/policies", <ScrollText />, "Policies")}
        {item("/customers", <Building2 />, "Customers")}
      </SidebarSection>
      <SidebarSection title="Automate">
        {item("/autonomy", <Bot />, "Autonomy")}
        {item("/knowledge", <BookOpen />, "Knowledge")}
        {item("/connections", <Cable />, "Connections")}
      </SidebarSection>
      <SidebarSection title="Insights">
        {item("/replay", <History />, "Breach Replay")}
        {item("/billing", <Receipt />, "Billing")}
        {item("/audit", <ShieldCheck />, "Audit log")}
      </SidebarSection>
      <SidebarSection title="Organization">
        {item("/team", <Users />, "Team")}
        {item("/settings", <Settings />, "Settings")}
      </SidebarSection>
    </Sidebar>
  );
}

function TicketSearch() {
  const navigate = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || el.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q")?.toString().trim();
    navigate({ to: "/tickets", search: q ? { q } : {} });
    ref.current?.blur();
  };
  return (
    <search className="hidden w-full max-w-xs md:block">
      <form onSubmit={submit}>
        <label htmlFor="global-search" className="sr-only">
          Search tickets
        </label>
        <Input
          ref={ref}
          id="global-search"
          name="q"
          type="search"
          placeholder="Search tickets"
          leading={<Search />}
          trailing={<Kbd>/</Kbd>}
          className="w-full"
        />
      </form>
    </search>
  );
}

/** `?` opens the Help center from anywhere (not while typing; `/` stays ticket search). */
function useHelpShortcut() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      void navigate({ to: "/help" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}

function HelpButton() {
  return (
    <Button asChild variant="ghost" size="md" className="size-8.5 px-0!" aria-label="Help (?)" title="Help (?)">
      <Link to="/help">
        <CircleHelp aria-hidden />
      </Link>
    </Button>
  );
}

function UserMenu() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const router = useRouter();
  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSuccess: async () => {
      queryClient.clear();
      await router.navigate({ to: "/login" });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't sign out", description: errorMessage(e) }),
  });
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="rounded-full" aria-label={`Account: ${me.user.name}`}>
          <Avatar name={me.user.name} size="md" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block text-sm font-semibold text-ink">{me.user.name}</span>
          <span className="block text-xs font-normal text-ink-muted">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings aria-hidden /> Settings
          </Link>
        </DropdownMenuItem>
        {!me.user.mfaEnabled && (
          <DropdownMenuItem asChild>
            <Link to="/mfa/setup">
              <KeyRound aria-hidden /> Set up two-factor
            </Link>
          </DropdownMenuItem>
        )}
        {MOCK_MODE && (
          <DropdownMenuItem
            onSelect={async () => {
              await fetch("/api/v1/__mock/reset", { method: "POST" });
              window.location.assign("/");
            }}
          >
            <RotateCcw aria-hidden /> Reset demo data
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout.mutate()}>
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OrgMenu() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const router = useRouter();
  const switchOrg = useMutation({
    mutationFn: api.auth.switchOrg,
    onSuccess: async (next) => {
      queryClient.clear();
      queryClient.setQueryData(["me"], next);
      await router.navigate({ to: "/" });
      toast({ tone: "success", title: `Switched to ${next.organization.name}` });
    },
    onError: (e) => toast({ tone: "error", title: "Couldn't switch organization", description: errorMessage(e) }),
  });
  if (!me) return null;
  return (
    <OrgSwitcher
      current={me.organization}
      organizations={me.organizations}
      onSwitch={(id) => switchOrg.mutate(id)}
      onCreate={() => router.navigate({ to: "/signup" })}
    />
  );
}

export function AppLayout() {
  const nav = <Nav />;
  const { data: me } = useMe();
  // The mock API has no event stream; it keeps polling instead.
  useLiveUpdates(me?.organization.id, !MOCK_MODE);
  useHelpShortcut();
  return (
    <AppShell
      sidebar={nav}
      topBar={
        <TopBar>
          <AppShellMenuButton sidebar={nav} />
          <OrgMenu />
          {MOCK_MODE && (
            <Badge
              tone="accent"
              size="sm"
              className="hidden sm:inline-flex"
              title="Data is served by the in-browser mock API"
            >
              Demo data
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <LiveIndicator />
            <TicketSearch />
            <PageHelpButton />
            <HelpButton />
            <ThemeToggle />
            <UserMenu />
          </div>
        </TopBar>
      }
    >
      <BillingBanner />
      <Outlet />
      <WelcomeDialog />
    </AppShell>
  );
}
