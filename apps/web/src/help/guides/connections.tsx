import { AppLink, B, Callout, Defs, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="connect" title="Connecting a help desk">
        <P>
          Admins connect on <AppLink to="/connections">Connections</AppLink>: Zendesk, Jira Service Management,
          Intercom, Freshdesk, HubSpot, Zammad and more, with "Continue with…" sign-in where the help desk supports it,
          or an API token. The built-in <B>demo</B> help desk lets you try everything without a vendor account.
        </P>
        <P>
          slai reads tickets and their history. It writes to the help desk only under Assist or Autopilot rules (notes
          and replies) or when someone approves a draft, and every write is in the audit log.
        </P>
      </Section>

      <Section id="sync" title="Webhooks and sync">
        <Ul>
          <li>
            <B>Webhooks</B> tell slai the moment a ticket changes. Right after connecting, the connection page shows how
            to set them up: either paste the secret slai generated into your help desk, or (for Zendesk, Intercom,
            HubSpot and a few others) paste your help desk's signing secret into slai. slai ignores any update that
            isn't signed with it.
          </li>
          <li>
            A <B>catch-up sync</B> runs every few minutes anyway, so a missed webhook only delays an update; it never
            loses one.
          </li>
          <li>
            Each connection shows its <B>status</B> (active, error or paused), its last sync and its last error. An
            expired or revoked credential puts it in error until it is fixed.
          </li>
        </Ul>
      </Section>

      <Section id="mapping" title="Status and priority mapping">
        <P>slai measures every help desk with the same six status categories:</P>
        <Defs
          rows={[
            ["New, Open", "Work is with your team. Clocks run."],
            ["Pending", "Waiting on the customer. Clocks can pause here if the policy says so."],
            ["On hold", "Waiting on a third party. Clocks can pause here if the policy says so."],
            ["Solved, Closed", "Done. Clocks stop. A reopen resumes resolution."],
          ]}
        />
        <P>
          slai starts with a default mapping of your help desk's statuses and priorities. If your team uses custom
          statuses (say "Waiting on engineering"), open the connection and map them. Values slai has seen but cannot map
          are listed there. Saving a change re-reads the affected tickets, so their clocks are recalculated.
        </P>
        <Callout tone="warning" title="Mapping decides pauses">
          A status mapped to Open keeps the clock running; mapped to On hold it may pause it. Check custom statuses
          before you trust the numbers.
        </Callout>
      </Section>
    </>
  );
}

export const connections: Guide = {
  id: "connections",
  title: "Connections",
  summary:
    "Connecting a help desk, webhooks and catch-up sync, connection status, and mapping your statuses and priorities.",
  keywords: [
    "help desk",
    "zendesk",
    "jira",
    "intercom",
    "freshdesk",
    "hubspot",
    "zammad",
    "webhook",
    "secret",
    "sync",
    "status mapping",
    "custom status",
    "oauth",
    "demo",
    "integration",
  ],
  related: ["sla-clock", "knowledge", "getting-started"],
  sections: [
    { id: "connect", title: "Connecting a help desk" },
    { id: "sync", title: "Webhooks and sync" },
    { id: "mapping", title: "Status and priority mapping" },
  ],
  Body,
};
