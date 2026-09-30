import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checklist } from "../src/help/checklist";
import { WelcomeDialog, welcomeContent } from "../src/help/welcome";
import { api } from "../src/lib/api";
import { DashboardPage } from "../src/pages/dashboard/dashboard";
import { me, onboarding, queryClient, renderRouted, stubApi } from "./render-routed";

let session = me();
afterEach(() => vi.restoreAllMocks());

const stepRow = (id: string) => document.querySelector(`[data-step="${id}"]`) as HTMLElement;

describe("<Checklist>", () => {
  it("shows progress, done states, and a CTA to the exact place for each open step", async () => {
    renderRouted(<Checklist state={onboarding(["connect", "contract"])} canAct />);
    expect(await screen.findByRole("progressbar", { name: "2 of 6 setup steps done" })).toBeInTheDocument();
    expect(within(stepRow("connect")).getByText("Done")).toBeInTheDocument();
    expect(within(stepRow("connect")).getByText("(done)")).toBeInTheDocument();
    expect(stepRow("connect")).toHaveAttribute("data-done");

    const ctas: [string, string][] = [
      ["policy", "/contracts"],
      ["assign", "/customers"],
      ["autonomy", "/autonomy"],
      ["alerts", "/settings#notifications"],
      ["invite", "/team"],
      ["replay", "/replay"],
    ];
    for (const [id, href] of ctas) {
      expect(within(stepRow(id)).getByRole("link"), id).toHaveAttribute("href", href);
    }
    // The next required step is highlighted with the primary CTA.
    expect(within(stepRow("policy")).getByRole("link", { name: /Review: Approve a policy/ })).toBeInTheDocument();
    expect(within(stepRow("invite")).getByText("Optional")).toBeInTheDocument();
    expect(within(stepRow("replay")).getByText("Optional")).toBeInTheDocument();
    // Every step says why it matters.
    expect(screen.getByText(/reads your tickets and their history/)).toBeInTheDocument();
  });

  it("members and viewers see the steps with guides instead of CTAs", async () => {
    renderRouted(<Checklist state={onboarding()} canAct={false} />);
    await screen.findByText("Connect a help desk");
    const link = within(stepRow("connect")).getByRole("link", { name: "Learn how" });
    expect(link).toHaveAttribute("href", "/help/connections");
    expect(screen.getByText(/Owners and admins complete these steps/)).toBeInTheDocument();
  });

  it("hides when dismissed", async () => {
    const onDismiss = vi.fn();
    renderRouted(<Checklist state={onboarding()} canAct onDismiss={onDismiss} />);
    await userEvent.click(await screen.findByRole("button", { name: "Hide" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("the dashboard checklist", () => {
  const setup = (role: "owner" | "member", state = onboarding(["connect"])) => {
    stubApi();
    session = me(role);
    vi.spyOn(api.onboarding, "get").mockResolvedValue(state);
    return vi.spyOn(api.onboarding, "update");
  };

  it("shows for owners and admins of an org still setting up, and dismissing persists server-side", async () => {
    const update = setup("owner");
    update.mockResolvedValue(onboarding(["connect"], { checklistDismissed: true }));
    renderRouted(<DashboardPage />, { as: session });
    expect(await screen.findByRole("heading", { name: "Get started with slai" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(update.mock.calls[0]?.[0]).toEqual({ checklistDismissed: true });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Get started with slai" })).toBeNull());
  });

  it("is not shown to members, once dismissed, or once everything is done", async () => {
    setup("member");
    const a = renderRouted(<DashboardPage />, { as: session });
    await screen.findByRole("heading", { name: "Dashboard" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("heading", { name: "Get started with slai" })).toBeNull();
    a.unmount();

    vi.restoreAllMocks();
    setup("owner", onboarding(["connect"], { checklistDismissed: true }));
    const b = renderRouted(<DashboardPage />, { client: queryClient(), as: session });
    await screen.findByRole("heading", { name: "Dashboard" });
    await waitFor(() => expect(api.onboarding.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("heading", { name: "Get started with slai" })).toBeNull();
    b.unmount();

    vi.restoreAllMocks();
    setup("owner", onboarding(["connect", "contract", "policy", "assign", "autonomy", "alerts", "invite", "replay"]));
    renderRouted(<DashboardPage />, { client: queryClient(), as: session });
    await waitFor(() => expect(api.onboarding.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("heading", { name: "Get started with slai" })).toBeNull();
  });
});

describe("first-run welcome", () => {
  it("shows once: closing it marks it seen, and it does not come back", async () => {
    stubApi();
    session = me("owner");
    const get = vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding([], { welcomeSeen: false }));
    const update = vi.spyOn(api.onboarding, "update").mockResolvedValue(onboarding([], { welcomeSeen: true }));
    const user = userEvent.setup();
    const { unmount, history } = renderRouted(<WelcomeDialog />, { path: "/tickets", as: session });
    const dialog = await screen.findByRole("dialog", { name: "Welcome to slai, Ada" });
    expect(dialog).toHaveTextContent(/checklist on your dashboard/);
    await user.click(within(dialog).getByRole("button", { name: "Show me the checklist" }));
    expect(update.mock.calls[0]?.[0]).toEqual({ welcomeSeen: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    unmount();

    // Next session: the server says it was seen.
    get.mockResolvedValue(onboarding([], { welcomeSeen: true }));
    renderRouted(<WelcomeDialog />, { client: queryClient(), as: session });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape also counts as seen", async () => {
    stubApi();
    session = me("member");
    vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding([], { welcomeSeen: false }));
    const update = vi.spyOn(api.onboarding, "update").mockResolvedValue(onboarding([], { welcomeSeen: true }));
    renderRouted(<WelcomeDialog />, { as: session });
    await screen.findByRole("dialog", { name: "Welcome to Acme, Ada" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update.mock.calls[0]?.[0]).toEqual({ welcomeSeen: true });
  });

  it("is role-aware", () => {
    expect(welcomeContent("owner", "Ada", "Acme").primary.to).toBe("/");
    expect(welcomeContent("admin", "Ada", "Acme").secondary?.to).toBe("/onboarding");
    const member = welcomeContent("member", "Bo", "Acme");
    expect(member.primary.to).toBe("/approvals");
    expect(member.points.map((p) => p.text).join(" ")).toMatch(/Approve, edit or reject/);
    const viewer = welcomeContent("viewer", "Cy", "Acme");
    expect(viewer.intro).toMatch(/view-only/);
    expect(viewer.points.map((p) => p.text).join(" ")).not.toMatch(/Approve, edit or reject/);
  });
});
