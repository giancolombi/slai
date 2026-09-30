import type { Risk, TicketStatus } from "@slai/shared";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppLayout } from "./app-layout";
import { ErrorState } from "./components/page";
import { isApiError } from "./lib/api";
import { mfaRedirect } from "./lib/auth-flow";
import { meQuery } from "./lib/queries";
import { NotFound } from "./pages/not-found";

export interface RouterContext {
  queryClient: QueryClient;
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

/** Resolves the session or sends the visitor to sign in. */
async function requireSession(queryClient: QueryClient, href: string) {
  try {
    return await queryClient.ensureQueryData(meQuery);
  } catch (e) {
    if (isApiError(e) && e.status === 401) {
      throw redirect({ to: "/login", search: { redirect: href === "/" ? undefined : href } });
    }
    throw e;
  }
}

/** A session whose second factor is done; otherwise mandatory enrollment or verification first. */
async function requireMfaSession(queryClient: QueryClient, href: string) {
  const me = await requireSession(queryClient, href);
  const to = mfaRedirect(me);
  if (to === "/mfa/setup") throw redirect({ to });
  if (to === "/mfa") throw redirect({ to, search: { redirect: href === "/" ? undefined : href } });
  return me;
}

// ---------------------------------------------------------------- public: auth + design

const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "_auth",
  component: lazyRouteComponent(() => import("./pages/auth/auth-layout"), "AuthLayout"),
});

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { redirect?: string; sso_error?: string } => ({
    redirect: str(s.redirect),
    sso_error: str(s.sso_error),
  }),
  component: lazyRouteComponent(() => import("./pages/auth/login"), "LoginPage"),
});

const signupRoute = createRoute({
  getParentRoute: () => authLayout,
  path: "/signup",
  component: lazyRouteComponent(() => import("./pages/auth/signup"), "SignupPage"),
});

const mfaRoute = createRoute({
  getParentRoute: () => authLayout,
  path: "/mfa",
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({ redirect: str(s.redirect) }),
  component: lazyRouteComponent(() => import("./pages/auth/mfa"), "MfaChallengePage"),
});

const mfaSetupRoute = createRoute({
  getParentRoute: () => authLayout,
  path: "/mfa/setup",
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: lazyRouteComponent(() => import("./pages/auth/mfa-setup"), "MfaSetupPage"),
});

const designRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design",
  component: lazyRouteComponent(() => import("./pages/design/design"), "DesignPage"),
});

// ---------------------------------------------------------------- onboarding (session, no shell)

export type OnboardingStep = "connect" | "contract" | "review" | "replay";
const ONBOARDING_STEPS: OnboardingStep[] = ["connect", "contract", "review", "replay"];

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  validateSearch: (s: Record<string, unknown>): { step?: OnboardingStep } => ({
    step: ONBOARDING_STEPS.includes(s.step as OnboardingStep) ? (s.step as OnboardingStep) : undefined,
  }),
  beforeLoad: ({ context, location }) => requireMfaSession(context.queryClient, location.href),
  component: lazyRouteComponent(() => import("./pages/onboarding/onboarding"), "OnboardingPage"),
});

// ---------------------------------------------------------------- the app (session + shell)

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ context, location }) => ({ me: await requireMfaSession(context.queryClient, location.href) }),
  component: AppLayout,
  errorComponent: ({ error, reset }) => (
    <div className="p-8">
      <ErrorState error={error} onRetry={reset} />
    </div>
  ),
});

const dashboardRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/dashboard/dashboard"), "DashboardPage"),
});

export interface TicketSearch {
  risk?: Risk;
  status?: TicketStatus;
  customerId?: string;
  q?: string;
}
const RISKS: Risk[] = ["ok", "warning", "at_risk", "breached"];
const STATUSES: TicketStatus[] = ["new", "open", "pending", "on_hold", "solved", "closed"];

const ticketsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/tickets",
  validateSearch: (s: Record<string, unknown>): TicketSearch => ({
    risk: RISKS.includes(s.risk as Risk) ? (s.risk as Risk) : undefined,
    status: STATUSES.includes(s.status as TicketStatus) ? (s.status as TicketStatus) : undefined,
    customerId: str(s.customerId),
    q: str(s.q),
  }),
  component: lazyRouteComponent(() => import("./pages/tickets/tickets"), "TicketsPage"),
});

const ticketRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/tickets/$ticketId",
  component: lazyRouteComponent(() => import("./pages/tickets/ticket-detail"), "TicketDetailPage"),
});

const approvalsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/approvals",
  component: lazyRouteComponent(() => import("./pages/approvals/approvals"), "ApprovalsPage"),
});

const contractsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/contracts",
  component: lazyRouteComponent(() => import("./pages/contracts/contracts"), "ContractsPage"),
});

const contractRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/contracts/$contractId",
  component: lazyRouteComponent(() => import("./pages/contracts/contract-review"), "ContractReviewPage"),
});

const policiesRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/policies",
  validateSearch: (s: Record<string, unknown>): { policyId?: string } => ({ policyId: str(s.policyId) }),
  component: lazyRouteComponent(() => import("./pages/policies/policies"), "PoliciesPage"),
});

const customersRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/customers",
  component: lazyRouteComponent(() => import("./pages/customers/customers"), "CustomersPage"),
});

const connectionsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/connections",
  component: lazyRouteComponent(() => import("./pages/connections/connections"), "ConnectionsPage"),
});

const autonomyRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/autonomy",
  component: lazyRouteComponent(() => import("./pages/autonomy/autonomy"), "AutonomyPage"),
});

const knowledgeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/knowledge",
  component: lazyRouteComponent(() => import("./pages/knowledge/knowledge"), "KnowledgePage"),
});

const replaysRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/replay",
  component: lazyRouteComponent(() => import("./pages/replay/replays"), "ReplaysPage"),
});

const replayRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/replay/$replayId",
  component: lazyRouteComponent(() => import("./pages/replay/replay-report"), "ReplayReportPage"),
});

/** Where Stripe Checkout and the Customer Portal send the browser back (`?checkout=success|canceled`). */
export interface BillingSearch {
  checkout?: "success" | "canceled";
  credits?: "success" | "canceled";
  portal?: "return";
}
const outcome = (v: unknown) => (v === "success" || v === "canceled" ? v : undefined);

const billingRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/billing",
  validateSearch: (s: Record<string, unknown>): BillingSearch => ({
    checkout: outcome(s.checkout),
    credits: outcome(s.credits),
    portal: s.portal === "return" ? "return" : undefined,
  }),
  component: lazyRouteComponent(() => import("./pages/usage/usage"), "BillingPage"),
});

/** The page used to be "Usage & billing" at /usage. */
const usageRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/usage",
  beforeLoad: () => {
    throw redirect({ to: "/billing", replace: true });
  },
});

const auditRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/audit",
  component: lazyRouteComponent(() => import("./pages/audit/audit"), "AuditPage"),
});

const teamRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/team",
  component: lazyRouteComponent(() => import("./pages/team/team"), "TeamPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/settings/settings"), "SettingsPage"),
});

const routeTree = rootRoute.addChildren([
  authLayout.addChildren([loginRoute, signupRoute, mfaRoute, mfaSetupRoute]),
  designRoute,
  onboardingRoute,
  appLayout.addChildren([
    dashboardRoute,
    ticketsRoute,
    ticketRoute,
    approvalsRoute,
    contractsRoute,
    contractRoute,
    policiesRoute,
    customersRoute,
    connectionsRoute,
    autonomyRoute,
    knowledgeRoute,
    replaysRoute,
    replayRoute,
    billingRoute,
    usageRoute,
    auditRoute,
    teamRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultPendingMinMs: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
