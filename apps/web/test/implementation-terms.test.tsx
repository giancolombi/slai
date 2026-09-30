/**
 * Guard: the product shows only information relevant to support users. Every main page is rendered
 * against the mock API (the same fixtures as the demo, including model names, costs and sandbox
 * seconds on agent runs) and its visible text must not contain implementation terms.
 */
import type { Role } from "@slai/shared";
import { TooltipProvider } from "@slai/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_IDS } from "../src/help/types";
import { getDb, org, resetDb } from "../src/mocks/db";
import { handlers } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";

/**
 * Words that mean the UI is leaking how slai is built. Tuned for false positives: customer
 * content (ticket subjects, help articles) legitimately says "API token" or "request ID", so
 * those are not listed; token *counts* are.
 */
export const FORBIDDEN =
  /(\bclaude-|\bgpt-|\bqwen\b|\bollama\b|\be2b\b|\bsandbox(?:ed|es)?\b|\bsandbox (?:id|seconds|time)\b|\b\d[\d,.]*\s*(?:k\s*)?tokens\b|\bmicro-?dollars?\b|\bmicros\b|\bRLS\b|pg-boss|\bNOTIFY\b|\bTR-\d|\bPR-\d|\bT-\d{2}\b|\bpolicies\[\d+\]|\bcalendar\.weekly\b|\bmodel_call\b|\bDATABASE_[A-Z_]+|\bMODEL_PROVIDER\b|\bdeterministic\b|\bmock (?:provider|mode)\b|\bDesign system\b|\bwall\b|\b(?:first_response|next_response|periodic_update|on_hold|needs_review|at_risk|draft_reply|public_reply|internal_note|sandbox_seconds|contract_extraction|autopilot_reply)\b|\b[a-z_]+\.[a-z_]+_[a-z_]+\b)/i;

/** UUIDs are internal ids; admins only ever need them inside a copyable setup value (a <code>). */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const server = setupServer(...handlers);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  window.scrollTo = () => {};
  server.listen({ onUnhandledRequest: "bypass" });
});
beforeEach(() => resetDb());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Visible text with a space between text nodes, so words from adjacent elements don't run together. */
function textOf(root: Node): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ");
}

async function firstId(path: string): Promise<string> {
  const res = await fetch(`${location.origin}/api/v1${path}`);
  const body = (await res.json()) as { items?: { id: string }[] } | { id: string }[];
  const items = Array.isArray(body) ? body : (body.items ?? []);
  if (!items[0]) throw new Error(`no fixture for ${path}`);
  return items[0].id;
}

/** Renders a path as the given role and returns its visible text once loading is done. */
async function visibleText(
  path: string,
  role: Role = "owner",
): Promise<{ text: string; outsideCode: string; buttons: string[] }> {
  getDb().me.role = role;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(client);
  router.update({ ...router.options, history: createMemoryHistory({ initialEntries: [path] }) });
  const { container, unmount } = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await waitFor(
    () => {
      const t = container.textContent ?? "";
      expect(t.length).toBeGreaterThan(400);
      expect(
        container.querySelector('[role="status"][aria-live="polite"] .sr-only, [aria-label^="Loading"]'),
      ).toBeNull();
      expect(t).not.toMatch(/Loading/);
    },
    { timeout: 8000 },
  );
  // Let late queries (sidebar badges, usage) settle.
  await new Promise((r) => setTimeout(r, 600));
  const text = textOf(container);
  const clone = container.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll("code, pre")) el.remove();
  const outsideCode = textOf(clone);
  const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
  unmount();
  return { text, outsideCode, buttons };
}

function expectClean(path: string, { text, outsideCode }: { text: string; outsideCode: string }) {
  const hit = text.match(FORBIDDEN);
  expect(
    hit?.[0],
    `${path} shows "${hit?.[0]}" in: …${hit ? text.slice(Math.max(0, hit.index! - 80), hit.index! + 80) : ""}…`,
  ).toBeUndefined();
  const id = outsideCode.match(UUID);
  expect(id?.[0], `${path} shows an internal id`).toBeUndefined();
}

const PAGES = [
  "/",
  "/tickets",
  "/approvals",
  "/contracts",
  "/policies",
  "/customers",
  "/connections",
  "/autonomy",
  "/knowledge",
  "/replay",
  "/billing",
  "/audit",
  "/team",
  "/settings",
  "/help",
];

describe("pages show no implementation details (owner)", () => {
  for (const path of PAGES) {
    it(path, { timeout: 20_000 }, async () => {
      expectClean(path, await visibleText(path));
    });
  }

  it("ticket detail with agent runs: no model, cost, sandbox or timing", { timeout: 20_000 }, async () => {
    const ticket = org().tickets.find((t) => t.agentRuns.some((r) => r.model));
    expect(ticket, "the fixtures include a ticket with agent runs").toBeDefined();
    // The API data carries the internals (so this guard is meaningful)...
    const raw = await (await fetch(`${location.origin}/api/v1/tickets/${ticket!.id}`)).text();
    expect(raw).toMatch(/claude-|sandboxSeconds/);
    // ...and the page doesn't render them.
    const path = `/tickets/${ticket!.id}`;
    const page = await visibleText(path);
    expectClean(path, page);
    expect(page.text).toMatch(/Agent activity/);
    expect(page.text).toMatch(/\d+ credits?\b/);
  });

  for (const [list, detail] of [
    ["/contracts", "/contracts/"],
    ["/connections", "/connections/"],
    ["/replays", "/replay/"],
  ] as const) {
    it(`${detail}:id`, { timeout: 20_000 }, async () => {
      const path = `${detail}${await firstId(list)}`;
      expectClean(path, await visibleText(path));
    });
  }

  for (const guide of GUIDE_IDS) {
    it(`/help/${guide}`, { timeout: 20_000 }, async () => {
      expectClean(`/help/${guide}`, await visibleText(`/help/${guide}`));
    });
  }
});

describe("members and viewers don't see controls or setup details they can't use", () => {
  it("members: no audit log, no webhook setup", { timeout: 20_000 }, async () => {
    const dash = await visibleText("/", "member");
    expectClean("/ (member)", dash);
    expect(dash.text).not.toMatch(/Audit log/);
    const conns = await visibleText("/connections", "member");
    expect(conns.text).not.toMatch(/Webhook URL/);
    expect(conns.text).not.toMatch(/Add help desk|Connect a help desk/);
  });

  it("viewers: drafts are read-only and agents can't be run", { timeout: 20_000 }, async () => {
    const inbox = await visibleText("/approvals", "viewer");
    expectClean("/approvals (viewer)", inbox);
    expect(inbox.buttons.join("|")).not.toMatch(/Approve & (send|post|apply)|Reject…/);
    const id = org().tickets.find((t) => t.agentRuns.length)!.id;
    const ticket = await visibleText(`/tickets/${id}`, "viewer");
    expect(ticket.buttons.join("|")).not.toMatch(/Run triage|Draft reply|Approve & send|Reject…/);
  });
});
