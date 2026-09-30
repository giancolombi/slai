import type { Me, OnboardingState } from "@slai/shared";
import { TooltipProvider } from "@slai/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { api } from "../src/lib/api";
import { qk } from "../src/lib/queries";

export const me = (role: Me["role"] = "owner"): Me => ({
  user: { id: "u1", email: "ada@acme.example", name: "Ada Lovelace", mfaEnabled: true },
  organization: { id: "o1", name: "Acme", slug: "acme", plan: "growth" },
  role,
  organizations: [{ id: "o1", name: "Acme", role }],
  security: {
    authMethod: "password",
    mfa: "satisfied",
    totp: true,
    passkeys: 0,
    hasPassword: true,
    stepUpUntil: null,
  },
});

export function onboarding(done: string[] = [], over: Partial<OnboardingState> = {}): OnboardingState {
  const ids = ["connect", "contract", "policy", "assign", "autonomy", "alerts", "invite", "replay"] as const;
  const steps = ids.map((id) => ({ id, done: done.includes(id), optional: id === "invite" || id === "replay" }));
  const required = steps.filter((s) => !s.optional);
  return {
    steps,
    requiredDone: required.filter((s) => s.done).length,
    requiredTotal: required.length,
    allDone: steps.every((s) => s.done),
    checklistDismissed: false,
    welcomeSeen: true,
    ...over,
  };
}

/**
 * Replaces every API call with one that never resolves (pages stay in their loading
 * state), so a test only stubs what it asserts on.
 */
export function stubApi() {
  for (const group of Object.values(api) as Record<string, unknown>[]) {
    for (const key of Object.keys(group)) {
      if (typeof group[key] === "function") {
        vi.spyOn(group as Record<string, () => unknown>, key).mockImplementation(() => new Promise(() => {}));
      }
    }
  }
}

export function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/** Renders `ui` at `path` inside a minimal router whose routes accept any link target. */
export function renderRouted(
  ui: ReactNode,
  { path = "/", client = queryClient(), as }: { path?: string; client?: QueryClient; as?: Me } = {},
) {
  // `meQuery` holds a reference to the real `api.auth.me`, so the session is seeded, not stubbed.
  if (as) client.setQueryData(qk.me, as);
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({ getParentRoute: () => root, path: "$", component: () => <>{ui}</> });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: root.addChildren([page]), history });
  const utils = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, client, history };
}
