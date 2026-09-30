import { TooltipProvider } from "@slai/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PAGE_HELP } from "../src/help/page-help";
import { GUIDE_IDS } from "../src/help/types";
import { api } from "../src/lib/api";
import { qk } from "../src/lib/queries";
import { APP_PAGE_ROUTES, createAppRouter } from "../src/router";
import { me, onboarding, queryClient, stubApi } from "./render-routed";

beforeAll(() => {
  // Radix and the charts measure elements; jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => vi.restoreAllMocks());

/** Every page in the app shell (a redirect-only route like /usage has no component). */
function pagePaths(): string[] {
  createAppRouter(queryClient()); // resolves each route's fullPath
  return APP_PAGE_ROUTES.filter((r) => r.options.component).map((r) => r.fullPath);
}

describe("every page has help (guard: new pages can't ship without it)", () => {
  it("each routed page has an About-this-page entry that links to real guides", () => {
    const paths = pagePaths();
    expect(paths.length).toBeGreaterThanOrEqual(20);
    for (const p of paths) {
      const help = PAGE_HELP[p];
      expect(help, `PAGE_HELP is missing "${p}"`).toBeDefined();
      expect(help!.purpose.length, p).toBeGreaterThan(20);
      expect(help!.next.length, p).toBeGreaterThan(0);
      expect(help!.guides.length, p).toBeGreaterThan(0);
      for (const g of help!.guides) expect(GUIDE_IDS, `${p} → ${g}`).toContain(g);
    }
  });

  it("has no stale entries for pages that no longer exist", () => {
    const paths = new Set(pagePaths());
    for (const p of Object.keys(PAGE_HELP)) expect(paths.has(p), `stale PAGE_HELP entry "${p}"`).toBe(true);
  });
});

const sample = (path: string) =>
  path
    .replace("$ticketId", "t1")
    .replace("$contractId", "c1")
    .replace("$connectionId", "k1")
    .replace("$replayId", "r1")
    .replace("$guideId", "sla-clock");

function renderApp(path: string) {
  const client = queryClient();
  client.setQueryData(qk.me, me("owner"));
  const router = createAppRouter(client);
  router.update({ ...router.options, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("the contextual help panel opens on each page", () => {
  for (const path of Object.keys(PAGE_HELP)) {
    it(`${path}`, { timeout: 15_000 }, async () => {
      stubApi();
      vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding());
      const user = userEvent.setup();
      renderApp(sample(path));
      const title = PAGE_HELP[path]!.title;
      const button = await screen.findByRole("button", { name: `About this page: ${title}` }, { timeout: 5000 });
      await user.click(button);
      const dialog = await screen.findByRole("dialog", { name: `About this page: ${title}` });
      expect(within(dialog).getByRole("heading", { name: "What this page is for" })).toBeInTheDocument();
      expect(within(dialog).getByText(PAGE_HELP[path]!.purpose)).toBeInTheDocument();
      expect(within(dialog).getAllByRole("link").length).toBeGreaterThan(PAGE_HELP[path]!.guides.length - 1);
      // Focus moves into the dialog and returns to the button when it closes.
      expect(dialog.contains(document.activeElement)).toBe(true);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(button).toHaveFocus();
    });
  }
});

describe("the ? shortcut", () => {
  it("opens Help from anywhere, but not while typing", async () => {
    stubApi();
    vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding());
    const user = userEvent.setup();
    const router = renderApp("/tickets");
    const search = await screen.findByRole("searchbox", { name: "Search tickets" }, { timeout: 5000 });
    await user.click(search);
    await user.keyboard("?");
    expect(router.state.location.pathname).toBe("/tickets");
    search.blur();
    await user.keyboard("?");
    await waitFor(() => expect(router.state.location.pathname).toBe("/help"));
  });

  it("the top bar and the sidebar footer link to Help", async () => {
    stubApi();
    vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding());
    renderApp("/tickets");
    expect(await screen.findByRole("link", { name: "Help (?)" }, { timeout: 5000 })).toHaveAttribute("href", "/help");
    const nav = screen.getByRole("navigation", { name: "Main" }).parentElement!;
    expect(within(nav).getByRole("link", { name: "Help" })).toHaveAttribute("href", "/help");
  });
});
