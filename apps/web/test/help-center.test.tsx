import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDES, getGuide, searchHelp } from "../src/help/guides";
import { GUIDE_TITLES } from "../src/help/titles";
import { GUIDE_IDS } from "../src/help/types";
import { api } from "../src/lib/api";
import { HelpCenterPage } from "../src/pages/help/help-center";
import { me, onboarding, renderRouted, stubApi } from "./render-routed";

let session = me();
afterEach(() => vi.restoreAllMocks());

describe("guides are complete and consistent", () => {
  it("every guide id has a guide, with a title matching the link titles and valid related guides", () => {
    expect(GUIDES.map((g) => g.id)).toEqual([...GUIDE_IDS]);
    for (const g of GUIDES) {
      expect(g.title, g.id).toBe(GUIDE_TITLES[g.id]);
      expect(g.summary.length, g.id).toBeGreaterThan(20);
      for (const r of g.related) expect(GUIDE_IDS, `${g.id} → ${r}`).toContain(r);
      expect(g.related, g.id).not.toContain(g.id);
    }
  });

  it("each guide renders real headings, and every listed section has its anchor", async () => {
    for (const g of GUIDES) {
      const { Body } = g;
      const { container, unmount } = renderRouted(<Body />);
      await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(100));
      for (const s of g.sections) {
        const el = container.querySelector(`#${CSS.escape(s.id)}`);
        expect(el, `${g.id}#${s.id}`).not.toBeNull();
        expect(el?.tagName, `${g.id}#${s.id}`).toBe("H2");
      }
      unmount();
    }
  });

  it("the required topics are covered", () => {
    const faq = getGuide("faq")!;
    const questions = faq.sections.map((s) => s.title);
    for (const q of [
      "Why didn't autopilot send this reply?",
      "Why is this ticket breached if we replied?",
      "Why is a ticket not measured?",
      "Why don't I see my customer's policy applied?",
      "Is my customer data used to train AI?",
    ]) {
      expect(questions).toContain(q);
    }
  });
});

describe("help search", () => {
  it("finds guides, sections, FAQ entries and glossary terms", () => {
    const pause = searchHelp("pause");
    expect(pause.some((r) => r.guide === "sla-clock" && r.anchor === "pauses")).toBe(true);
    expect(searchHelp("autopilot send")[0]).toMatchObject({ guide: "faq", anchor: "autopilot-not-sent" });
    expect(searchHelp("train")[0]).toMatchObject({ guide: "faq", anchor: "training" });
    expect(searchHelp("tracked ticket").some((r) => r.guide === "glossary" && r.anchor === "tracked-ticket")).toBe(
      true,
    );
    expect(searchHelp("SCIM")[0]?.guide).toBe("team-security");
    expect(searchHelp("keyboard shortcuts")[0]).toMatchObject({ guide: "approvals" });
  });

  it("needs every word to match, ignores case and accents, and returns nothing for nonsense", () => {
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
    expect(searchHelp("zzqx")).toEqual([]);
    expect(searchHelp("BUSINESS HOURS")[0]?.guide).toBe("sla-clock");
    expect(searchHelp("pausé").some((r) => r.anchor === "pauses")).toBe(true);
    expect(searchHelp("autopilot zzqx")).toEqual([]);
  });

  it("is keyboard friendly: type, arrow into results, Enter opens one", async () => {
    stubApi();
    session = me();
    vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding(["connect"]));
    const user = userEvent.setup();
    const { history } = renderRouted(<HelpCenterPage />, { path: "/help", as: session });
    const input = await screen.findByRole("searchbox", { name: "Search help" });
    await user.click(input);
    await user.type(input, "pause");
    const results = screen.getByRole("list", { name: "Search results" });
    const links = within(results).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    await user.keyboard("{ArrowDown}");
    expect(links[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(links[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(history.location.pathname).toMatch(/^\/help\//));
  });

  it("shows a helpful empty state, and Escape clears the search", async () => {
    stubApi();
    session = me();
    vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding());
    const user = userEvent.setup();
    renderRouted(<HelpCenterPage />, { path: "/help", as: session });
    const input = await screen.findByRole("searchbox", { name: "Search help" });
    await user.type(input, "zzqx");
    expect(screen.getByText("Nothing matches “zzqx”")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(await screen.findByRole("heading", { name: "Start here" })).toBeInTheDocument();
  });
});

describe("the help center restores a hidden checklist", () => {
  it("shows the checklist and brings it back to the dashboard", async () => {
    stubApi();
    session = me("admin");
    vi.spyOn(api.onboarding, "get").mockResolvedValue(onboarding(["connect"], { checklistDismissed: true }));
    const update = vi
      .spyOn(api.onboarding, "update")
      .mockResolvedValue(onboarding(["connect"], { checklistDismissed: false }));
    const user = userEvent.setup();
    renderRouted(<HelpCenterPage />, { path: "/help", as: session });
    await user.click(await screen.findByRole("button", { name: "Show it on the dashboard" }));
    expect(update.mock.calls[0]?.[0]).toEqual({ checklistDismissed: false });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show it on the dashboard" })).toBeNull());
  });
});
