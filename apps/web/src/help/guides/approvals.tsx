import { Kbd } from "@slai/ui";
import { AppLink, B, Defs, GuideLink, Ol, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="what" title="What lands in Approvals">
        <Ul>
          <li>
            Drafts written under an <B>Assist</B> rule, when a ticket reached the rule's trigger.
          </li>
          <li>
            <B>Autopilot</B> drafts that a guardrail held back, with the reason (for example "draft flagged: promises a
            timeline").
          </li>
          <li>Drafts someone asked for by running the agents on a ticket by hand.</li>
        </Ul>
        <P>Nothing in Approvals has reached the customer.</P>
      </Section>

      <Section id="workflow" title="The workflow">
        <Ol>
          <li>
            Open a draft. You see the ticket, its SLA clock, the draft with its confidence, why autopilot held it (if it
            did), and the knowledge it used.
          </li>
          <li>
            <B>Approve</B> to send it as a public reply in your help desk, <B>edit</B> it first, or <B>reject</B> it
            (optionally with a reason).
          </li>
          <li>
            slai sends each approved reply once, records who approved it in the audit log, and re-reads the ticket, so
            your reply stops the clock.
          </li>
        </Ol>
        <P>
          Members, admins and owners can approve. Viewers can read the inbox. Suggested priority and assignee changes
          are always proposals too.
        </P>
      </Section>

      <Section id="shortcuts" title="Keyboard shortcuts">
        <Defs
          rows={[
            [
              <span key="jk" className="inline-flex gap-1">
                <Kbd>j</Kbd> <Kbd>k</Kbd>
              </span>,
              "Next and previous draft (the arrow keys work too).",
            ],
            [<Kbd key="a">a</Kbd>, "Approve and send the selected draft."],
            [<Kbd key="e">e</Kbd>, "Edit the draft."],
            [<Kbd key="r">r</Kbd>, "Reject the draft."],
            [<Kbd key="esc">Esc</Kbd>, "Leave the editor."],
            [<Kbd key="q">?</Kbd>, "Open Help (anywhere in slai)."],
            [<Kbd key="s">/</Kbd>, "Search tickets (anywhere in slai)."],
          ]}
        />
        <P>Shortcuts are off while you type in a field.</P>
      </Section>

      <Section id="empty" title="An empty inbox">
        <P>
          No drafts means no ticket reached a trigger under an Assist or Autopilot rule, or every rule is Observe. Check{" "}
          <AppLink to="/autonomy">Autonomy</AppLink> and read <GuideLink to="autonomy">Choosing autonomy</GuideLink>.
        </P>
      </Section>
    </>
  );
}

export const approvals: Guide = {
  id: "approvals",
  title: "Approvals",
  summary: "How drafts reach the approvals inbox, how to approve, edit or reject them, and the keyboard shortcuts.",
  keywords: [
    "inbox",
    "draft",
    "approve",
    "reject",
    "edit",
    "keyboard",
    "shortcuts",
    "hotkeys",
    "send",
    "reply",
    "blocked",
  ],
  related: ["autonomy", "knowledge", "faq"],
  sections: [
    { id: "what", title: "What lands in Approvals" },
    { id: "workflow", title: "The workflow" },
    { id: "shortcuts", title: "Keyboard shortcuts" },
    { id: "empty", title: "An empty inbox" },
  ],
  Body,
};
