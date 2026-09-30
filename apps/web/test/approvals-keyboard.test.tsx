import type { AgentAction } from "@slai/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalsInbox } from "../src/pages/approvals/inbox";

function draft(n: number, extra: Partial<AgentAction> = {}): AgentAction {
  return {
    id: `act_${n}`,
    ticketId: `t_${n}`,
    ticketKey: `#100${n}`,
    ticketSubject: `Subject ${n}`,
    kind: "public_reply",
    status: "proposed",
    body: `Draft body ${n}`,
    payload: {},
    confidence: 0.8,
    blockedReason: null,
    createdAt: new Date(Date.now() - n * 60_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...extra,
  };
}

const items = [draft(1), draft(2), draft(3)];

function selectedSubject() {
  const option = screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
  return option ? within(option).getByText(/Subject/).textContent : null;
}

/** Mirrors the page: a decided draft leaves the list. */
function Harness({
  onApprove,
  onReject,
}: {
  onApprove: (item: AgentAction, body: string) => void;
  onReject: (item: AgentAction, reason: string | undefined) => void;
}) {
  const [list, setList] = useState(items);
  return (
    <ApprovalsInbox
      items={list}
      onApprove={(item, body) => {
        onApprove(item, body);
        setList((l) => l.filter((x) => x.id !== item.id));
      }}
      onReject={(item, reason) => {
        onReject(item, reason);
        setList((l) => l.filter((x) => x.id !== item.id));
      }}
    />
  );
}

describe("Approvals inbox keyboard shortcuts", () => {
  it("moves the selection with j and k", async () => {
    const user = userEvent.setup();
    render(<ApprovalsInbox items={items} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(selectedSubject()).toBe("Subject 1");
    await user.keyboard("j");
    expect(selectedSubject()).toBe("Subject 2");
    await user.keyboard("jj");
    expect(selectedSubject()).toBe("Subject 3"); // clamps at the end
    await user.keyboard("k");
    expect(selectedSubject()).toBe("Subject 2");
  });

  it("approves the selected draft with a, then advances to the next one", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<Harness onApprove={onApprove} onReject={vi.fn()} />);
    await user.keyboard("j");
    await user.keyboard("a");
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "act_2" }), "Draft body 2");
    expect(selectedSubject()).toBe("Subject 3");
  });

  it("rejects the selected draft with r", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<Harness onApprove={vi.fn()} onReject={onReject} />);
    await user.keyboard("r");
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: "act_1" }), undefined);
    expect(selectedSubject()).toBe("Subject 2");
  });

  it("ignores shortcuts while typing in the editor, and sends the edited body", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ApprovalsInbox items={items} onApprove={onApprove} onReject={onReject} />);
    await user.keyboard("e");
    const editor = screen.getByRole("textbox", { name: /reply to the customer/i });
    expect(editor).toHaveFocus();

    await user.type(editor, " jkar");
    expect(editor).toHaveValue("Draft body 1 jkar");
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(selectedSubject()).toBe("Subject 1");

    await user.keyboard("{Escape}");
    expect(editor).not.toHaveFocus();
    await user.keyboard("a");
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "act_1" }), "Draft body 1 jkar");
  });

  it("shows inbox zero when nothing is waiting", () => {
    render(<ApprovalsInbox items={[]} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText("Inbox zero")).toBeInTheDocument();
  });
});
