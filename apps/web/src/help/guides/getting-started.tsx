import { AppLink, B, Callout, GuideLink, Ol, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="what-slai-does" title="What slai does for you">
        <P>
          Your contracts promise customers response and resolution times. slai reads those contracts, turns them into
          policies, and runs every ticket from your help desk on a clock that follows the contract exactly: its business
          hours, holidays, pause rules and priorities. You see what is about to breach while there is still time to act,
          and what each breach costs in service credits.
        </P>
        <P>
          On top of the clock, AI agents can triage tickets and draft replies. You decide how far they go: only alert
          you, draft for your approval, or reply on their own when every guardrail passes.
        </P>
      </Section>

      <Section id="five-minutes" title="The five-minute path">
        <Ol>
          <li>
            <B>Connect your help desk</B> on <AppLink to="/connections">Connections</AppLink>. slai starts reading
            tickets and their history. It writes nothing back until you turn on Assist or Autopilot.
          </li>
          <li>
            <B>Upload a contract</B> on <AppLink to="/contracts">Contracts</AppLink>: an MSA, an SLA schedule or an
            order form (PDF, DOCX, TXT or MD, up to 20 MB).
          </li>
          <li>
            <B>Review and approve the policy</B> slai extracted. Every number has a citation from the contract. Answer
            the open questions, then approve. See <GuideLink to="contract-review">Reviewing a contract</GuideLink>.
          </li>
          <li>
            <B>Assign policies to customers</B> on <AppLink to="/customers">Customers</AppLink>, or mark one policy as
            the default so every ticket is measured.
          </li>
          <li>
            <B>Choose autonomy</B> on <AppLink to="/autonomy">Autonomy</AppLink>. Start with Observe or Assist. See{" "}
            <GuideLink to="autonomy">Choosing autonomy</GuideLink>.
          </li>
          <li>
            <B>Set up alerts</B> in{" "}
            <AppLink to="/settings" hash="notifications">
              Settings → Notifications
            </AppLink>
            , so someone hears about risk before a breach.
          </li>
        </Ol>
        <P>Two optional steps make slai more useful straight away:</P>
        <Ul>
          <li>
            <B>Invite a teammate</B> from <AppLink to="/team">Team</AppLink>. slai prices by tickets, not seats.
          </li>
          <li>
            <B>Run a Breach Replay</B> from <AppLink to="/replay">Breach Replay</AppLink> to see the last 90 days
            through your contracts, priced in credits.
          </li>
        </Ul>
        <Callout title="The checklist tracks this for you">
          The getting-started checklist on the dashboard ticks each step off as it really happens (a connection that is
          active, a policy that is approved), not when you click a button. Hid it? Bring it back from the Help center.
        </Callout>
      </Section>

      <Section id="daily" title="What a normal day looks like">
        <Ul>
          <li>
            The <AppLink to="/">Dashboard</AppLink> shows open tickets by risk, what is due soon, attainment and the
            credits at stake this month.
          </li>
          <li>
            <AppLink to="/tickets">Tickets</AppLink> lists every ticket with its live clock, most urgent first.
          </li>
          <li>
            <AppLink to="/approvals">Approvals</AppLink> holds drafts waiting for a human. Approve, edit or reject them
            from the keyboard.
          </li>
          <li>Alerts reach email or Slack when a ticket crosses the risk level you chose.</li>
        </Ul>
      </Section>

      <Section id="roles" title="Who can do what">
        <Ul>
          <li>
            <B>Owners and admins</B> connect help desks, approve policies, set autonomy and alerts, and manage the team
            and billing.
          </li>
          <li>
            <B>Members</B> work tickets, upload contracts and approve or reject drafts.
          </li>
          <li>
            <B>Viewers</B> can see everything their organization sees, but change nothing.
          </li>
        </Ul>
      </Section>
    </>
  );
}

export const gettingStarted: Guide = {
  id: "getting-started",
  title: "Getting started",
  summary: "The five-minute path from a new account to live SLA clocks, alerts and your first Breach Replay.",
  keywords: ["setup", "onboarding", "checklist", "first steps", "quick start", "new", "begin", "roles"],
  related: ["contract-review", "sla-clock", "autonomy", "connections"],
  sections: [
    { id: "what-slai-does", title: "What slai does for you" },
    { id: "five-minutes", title: "The five-minute path" },
    { id: "daily", title: "What a normal day looks like" },
    { id: "roles", title: "Who can do what" },
  ],
  Body,
};
