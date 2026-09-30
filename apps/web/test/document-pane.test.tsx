import type { ContractText } from "@slai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { qk } from "../src/lib/queries";
import { DocumentPane, type DocumentPaneProps } from "../src/pages/contracts/document-pane";

const text: ContractText = {
  contractId: "c1",
  filename: "msa.pdf",
  truncated: false,
  pages: [
    { page: 1, text: "Schedule 4.\nSeverity 1: the Supplier shall  respond within\n30 minutes, 24x7." },
    { page: 2, text: "Severity 2: respond within 4 Business Hours. Credits apply." },
  ],
};
const citations = [
  { path: "targets.first_response.urgent", quote: "respond within 30 minutes", document: "msa.pdf", page: 1 },
  {
    path: "targets.first_response.high",
    quote: "Severity 2: respond within 4 business hours",
    document: "msa.pdf",
    page: 2,
  },
  { path: "credits.0", quote: "Not in this contract at all", document: "msa.pdf", page: 2 },
];

function setup(overrides: Partial<DocumentPaneProps> = {}) {
  const client = new QueryClient();
  client.setQueryData(qk.contractText("c1"), text);
  const onSelectPath = vi.fn();
  const props: DocumentPaneProps = {
    contractId: "c1",
    citations,
    activePath: null,
    focus: null,
    unresolved: new Set(),
    label: (p) => p,
    onSelectPath,
    ...overrides,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <DocumentPane {...props} />
    </QueryClientProvider>,
  );
  const rerender = (next: Partial<DocumentPaneProps>) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <DocumentPane {...props} {...next} />
      </QueryClientProvider>,
    );
  return { onSelectPath, rerender, container: view.container };
}

const markFor = (container: HTMLElement, path: string) =>
  [...container.querySelectorAll("mark")].filter((m) => m.dataset.paths?.split(" ").includes(path));

describe("DocumentPane", () => {
  it("marks each cited passage in place, as written in the document", () => {
    const { container } = setup();
    expect(screen.getByRole("region", { name: "Text of msa.pdf" })).toBeInTheDocument();
    expect(markFor(container, "targets.first_response.urgent").map((m) => m.textContent)).toEqual([
      "respond within\n30 minutes",
    ]);
    expect(markFor(container, "targets.first_response.high")[0]!.textContent).toBe(
      "Severity 2: respond within 4 Business Hours",
    );
    expect(screen.getByText(/1 quote isn't placed/)).toBeInTheDocument();
  });

  it("scrolls to a requested citation, highlights it and announces it; clicking a mark goes to its field", async () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    const { container, rerender, onSelectPath } = setup();
    const path = "targets.first_response.high";
    rerender({ focus: { path, nonce: 1 }, activePath: path });
    expect(scrollTo).toHaveBeenCalled();
    expect(markFor(container, path)[0]!.className).toMatch(/shadow-/);
    expect(markFor(container, "targets.first_response.urgent")[0]!.className).not.toMatch(/shadow-/);
    expect(screen.getByText(`Showing the quote for ${path} on page 2.`)).toBeInTheDocument();

    await userEvent.click(markFor(container, "targets.first_response.urgent")[0]!);
    expect(onSelectPath).toHaveBeenCalledWith("targets.first_response.urgent");

    rerender({ focus: { path: "credits.0", nonce: 2 } });
    expect(screen.getByText(/isn't in the extracted text \(it may span/)).toBeInTheDocument();
  });
});
