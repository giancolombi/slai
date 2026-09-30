import { AppLink, B, Callout, Defs, GuideLink, H3, Ol, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="levels" title="The three levels">
        <Defs
          rows={[
            [
              "Observe",
              "Alerts only. Agents do nothing. This is the default for any ticket no rule covers, and what agents fall back to when the plan or spend cap does not allow more.",
            ],
            [
              "Assist",
              "When a ticket reaches the trigger, an agent triages it and drafts a reply for one-click approval in Approvals. The triage and draft are also posted to the ticket as an internal note when your help desk supports notes. Nothing reaches the customer until a person approves.",
            ],
            [
              "Autopilot",
              "The draft is sent to the customer automatically, but only if it passes every guardrail. If it does not, it waits in Approvals with the reason.",
            ],
          ]}
        />
        <P>
          Start with Observe or Assist, read the drafts for a week, then move the customers and priorities you trust to
          Autopilot.
        </P>
      </Section>

      <Section id="rules" title="Rules: trigger, minimum confidence, and which rule wins">
        <P>
          A rule on <AppLink to="/autonomy">Autonomy</AppLink> sets the level for a customer, a priority, both, or
          everything (the default rule). Each rule also sets:
        </P>
        <Ul>
          <li>
            <B>Trigger</B>: the risk (warning, at risk or breached) at which agents start on a ticket.
          </li>
          <li>
            <B>Minimum confidence</B> (0.8 by default): autopilot only sends drafts the agent is at least this sure of.
          </li>
        </Ul>
        <H3>The most specific rule wins</H3>
        <Ol>
          <li>customer + priority</li>
          <li>customer (any priority)</li>
          <li>priority (any customer)</li>
          <li>the default rule</li>
          <li>no rule at all: Observe</li>
        </Ol>
        <P>The Autonomy grid shows each cell's effective level and where it is inherited from.</P>
      </Section>

      <Section id="guardrails" title="Autopilot guardrails">
        <P>Autopilot refuses to send, and puts the draft in Approvals with the reason, when:</P>
        <Ul>
          <li>
            the draft raised any <B>flag</B>: it promises a timeline, mentions pricing or refunds, touches legal or
            security topics, or is unsure of the facts;
          </li>
          <li>
            its <B>confidence</B> is below the rule's minimum;
          </li>
          <li>
            triage says the ticket <B>needs a human</B> (with a reason);
          </li>
          <li>the reply is empty or too long;</li>
          <li>
            it contains a <B>link or email address</B> that is not in the ticket thread or your knowledge;
          </li>
          <li>
            it looks like it contains <B>secrets or personal data</B> (a payment card number, a key or token).
          </li>
        </Ul>
        <P>
          Drafts are only as good as the facts they are given. Without relevant articles or saved replies, drafts flag
          themselves as unsure and autopilot holds them: see <GuideLink to="knowledge">Knowledge</GuideLink>.
        </P>
      </Section>

      <Section id="limits" title="Why your plan or spend can lower autonomy">
        <Ul>
          <li>
            <B>Plans</B> set a ceiling: Replay observes; Starter adds triage only; Growth allows Assist; Scale and
            Enterprise allow Autopilot. A rule above the ceiling runs at the ceiling.
          </li>
          <li>
            The <B>14-day trial</B> is Growth with autopilot off. When it ends without a plan, agents observe.
          </li>
          <li>
            A <B>failed payment</B> keeps your plan for a 7-day grace period, then agents observe until it is paid.
          </li>
          <li>
            At the <B>spend cap</B>, agents observe until next month or until an owner or admin raises the cap.
          </li>
        </Ul>
        <Callout title="Monitoring is never throttled">
          The SLA clocks, risk and alerts run on every plan and in every billing state, including over your limits. Only
          what the agents may do changes.
        </Callout>
      </Section>

      <Section id="first-connect" title="Connecting does not flood you">
        <P>
          When a help desk is first connected, tickets that breached long ago are shown but do not set off alerts or
          agents. Only tickets that are still actionable (at risk now, or breached within the last hour) react. You can
          always run the agents on a ticket by hand from its page.
        </P>
      </Section>
    </>
  );
}

export const autonomy: Guide = {
  id: "autonomy",
  title: "Choosing autonomy",
  summary:
    "Observe, assist and autopilot; triggers and minimum confidence; which rule wins; the autopilot guardrails; and why plans and the spend cap can lower autonomy.",
  keywords: [
    "observe",
    "assist",
    "autopilot",
    "agent",
    "ai",
    "draft",
    "triage",
    "trigger",
    "confidence",
    "guardrail",
    "rule",
    "most specific",
    "spend cap",
    "ceiling",
    "automation",
  ],
  related: ["approvals", "knowledge", "billing", "faq"],
  sections: [
    { id: "levels", title: "The three levels" },
    { id: "rules", title: "Rules: trigger, minimum confidence, and which rule wins" },
    { id: "guardrails", title: "Autopilot guardrails" },
    { id: "limits", title: "Why your plan or spend can lower autonomy" },
    { id: "first-connect", title: "Connecting does not flood you" },
  ],
  Body,
};
