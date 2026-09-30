import type { Connection, ConnectionMapping, ConnectorInfo, WebhookSecretReveal } from "@slai/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { oauthErrorMessage, UnmappedBanner } from "../src/pages/connections/connections";
import { OAuthConnect } from "../src/pages/connections/connector-form";
import {
  MappingEditor,
  mappingRows,
  NO_PRIORITY,
  toOverrides,
  USE_DEFAULT,
} from "../src/pages/connections/mapping-editor";
import { WebhookInstructions } from "../src/pages/connections/webhook-setup";

const mapping = (over: Partial<ConnectionMapping> = {}): ConnectionMapping => ({
  defaults: { status: { open: "open", hold: "on_hold" }, priority: { high: "high" } },
  overrides: { status: {}, priority: {} },
  unmapped: [
    { field: "status", raw: "Waiting on QA" },
    { field: "priority", raw: "P0" },
  ],
  observed: { status: ["open", "Waiting on QA"], priority: ["high", "P0"] },
  ...over,
});

/** Renders `ui` inside a memory router so <Link>s resolve. */
async function renderRouted(ui: ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{ui}</> });
  const detail = createRoute({ getParentRoute: () => root, path: "/connections/$connectionId" });
  const router = createRouter({
    routeTree: root.addChildren([index, detail]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const r = render(<RouterProvider router={router} />);
  return r;
}

describe("mapping rows (T-25)", () => {
  it("lists defaults, observed and unmapped raw values, unmapped first", () => {
    const rows = mappingRows(mapping());
    expect(rows.map((r) => `${r.field}:${r.raw}:${r.unmapped ? "!" : ""}`)).toEqual([
      "priority:P0:!",
      "status:Waiting on QA:!",
      "priority:high:",
      "status:hold:",
      "status:open:",
    ]);
    expect(rows.every((r) => r.choice === USE_DEFAULT)).toBe(true);
    expect(rows.find((r) => r.raw === "hold")?.defaultValue).toBe("on_hold");
    expect(rows.find((r) => r.raw === "P0")?.defaultValue).toBeUndefined();
  });

  it("turns choices into overrides, with 'no priority' as null and defaults left out", () => {
    const rows = mappingRows(
      mapping({ overrides: { status: { "Waiting on QA": "on_hold" }, priority: { P0: "urgent", high: null } } }),
    );
    expect(rows.find((r) => r.raw === "Waiting on QA")).toMatchObject({ choice: "on_hold", unmapped: false });
    expect(rows.find((r) => r.raw === "high")?.choice).toBe(NO_PRIORITY);
    expect(toOverrides(rows)).toEqual({
      status: { "Waiting on QA": "on_hold" },
      priority: { P0: "urgent", high: null },
    });
    expect(toOverrides(mappingRows(mapping()))).toEqual({ status: {}, priority: {} });
  });
});

describe("MappingEditor", () => {
  it("highlights unmapped values and explains what they count as", () => {
    render(<MappingEditor mapping={mapping()} canEdit onSave={() => {}} />);
    const status = screen.getByRole("table", { name: "Statuses mapping" });
    const qa = within(status).getByText("Waiting on QA").closest("tr")!;
    expect(qa).toHaveAttribute("data-unmapped");
    expect(within(qa).getByText("Unmapped")).toBeInTheDocument();
    const open = within(status).getByText("open").closest("tr")!;
    expect(open).not.toHaveAttribute("data-unmapped");
    expect(screen.getByRole("status")).toHaveTextContent("2 values need a mapping");
    // One select per raw value, labelled for assistive tech.
    expect(screen.getByRole("combobox", { name: "slai status for Waiting on QA" })).toHaveTextContent(
      "Default: Unmapped (counts as Open)",
    );
    // Nothing to save or reset yet.
    expect(screen.getByRole("button", { name: /save mapping/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeDisabled();
  });

  it("resets to the default mapping after confirming", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <MappingEditor
        mapping={mapping({ overrides: { status: { "Waiting on QA": "on_hold" }, priority: {} } })}
        canEdit
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole("button", { name: /reset to default/i }));
    await user.click(await screen.findByRole("button", { name: "Reset mapping" }));
    expect(onSave).toHaveBeenCalledWith({ status: {}, priority: {} });
  });

  it("is read-only for non-admins", () => {
    render(
      <MappingEditor
        mapping={mapping({ overrides: { status: { "Waiting on QA": "pending" }, priority: {} } })}
        canEdit={false}
        onSave={() => {}}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save mapping/i })).toBeNull();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Only admins can change the mapping.")).toBeInTheDocument();
  });
});

describe("Connections banner", () => {
  const conn = (id: string, name: string, issues: Connection["mappingIssues"]): Connection => ({
    id,
    provider: "zendesk",
    name,
    status: "active",
    lastSyncAt: null,
    lastError: null,
    mappingIssues: issues,
    webhookUrl: null,
    ticketCount: 0,
    createdAt: new Date().toISOString(),
  });

  it("shows when a connection has unmapped values and links to it", async () => {
    await renderRouted(
      <UnmappedBanner
        connections={[
          conn("c1", "Support", [
            { field: "status", raw: "Escalated" },
            { field: "priority", raw: "P0" },
          ]),
          conn("c2", "Billing", []),
        ]}
      />,
    );
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("2 help-desk values aren't mapped");
    expect(within(banner).getByRole("link", { name: "Support" })).toHaveAttribute("href", "/connections/c1");
    expect(within(banner).queryByRole("link", { name: "Billing" })).toBeNull();
  });

  it("stays hidden when everything is mapped", () => {
    const { container } = render(<UnmappedBanner connections={[conn("c2", "Billing", [])]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains OAuth failures in plain words", () => {
    expect(oauthErrorMessage("invalid_state")).toMatch(/expired or was used in another browser/);
    expect(oauthErrorMessage("something_new")).toMatch(/didn't finish/);
  });
});

describe("Continue with <Provider>", () => {
  const connector = (oauth: ConnectorInfo["oauth"]): ConnectorInfo => ({
    provider: "zendesk",
    displayName: "Zendesk",
    authKind: "api_token",
    fields: [],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    docsUrl: "https://example.com",
    oauth,
  });

  it("asks for the provider's params, then starts the flow at the API", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(
      <OAuthConnect
        connector={connector({ configured: true, params: [{ key: "subdomain", label: "Zendesk subdomain" }] })}
        name="Support desk"
        onStart={onStart}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue with Zendesk" }));
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText("Zendesk subdomain is required.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /zendesk subdomain/i }), "acme");
    await user.click(screen.getByRole("button", { name: "Continue with Zendesk" }));
    expect(onStart).toHaveBeenCalledWith("/api/v1/connections/oauth/zendesk/start?name=Support+desk&subdomain=acme");
  });

  it("is disabled with an explanation when the deployment has no OAuth app", () => {
    render(<OAuthConnect connector={connector({ configured: false, params: [] })} name="x" onStart={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Continue with Zendesk" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/isn't available yet/);
  });

  it("renders nothing for connectors without OAuth", () => {
    const { container } = render(<OAuthConnect connector={connector(undefined)} name="x" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Webhook setup", () => {
  const reveal = (over: Partial<WebhookSecretReveal> = {}): WebhookSecretReveal => ({
    webhookUrl: "https://api.slai.test/api/v1/webhooks/c1",
    secretSource: "slai",
    secret: "whsec_123",
    configured: true,
    steps: ["Create a webhook to {url}.", "Add the header X-Slai-Webhook-Secret: {secret}."],
    ...over,
  });

  it("fills the URL and secret into the provider's steps", () => {
    render(<WebhookInstructions reveal={reveal()} />);
    const steps = screen.getByRole("list", { name: "Setup steps" });
    expect(steps).toHaveTextContent("Create a webhook to https://api.slai.test/api/v1/webhooks/c1.");
    expect(steps).toHaveTextContent("X-Slai-Webhook-Secret: whsec_123.");
    expect(screen.getByRole("button", { name: "Copy webhook secret" })).toBeInTheDocument();
  });

  it("takes the provider's own signing secret when the help desk generates it", async () => {
    const user = userEvent.setup();
    const onSetSecret = vi.fn();
    render(
      <WebhookInstructions
        reveal={reveal({ secretSource: "provider", secret: null, configured: false, steps: ["Point it at {url}."] })}
        onSetSecret={onSetSecret}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copy webhook secret" })).toBeNull();
    expect(screen.getByText("Updates from your help desk are ignored until this is saved.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/signing secret from your help desk/i), "provider-secret-1");
    await user.click(screen.getByRole("button", { name: "Save secret" }));
    expect(onSetSecret).toHaveBeenCalledWith("provider-secret-1");
  });
});
