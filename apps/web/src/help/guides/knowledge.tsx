import { AppLink, B, Callout, GuideLink, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="why" title="Why drafts need knowledge">
        <P>
          Drafts may only state facts that are in the ticket thread or in the knowledge slai gives them. They never
          invent an answer. Without a relevant help-center article or saved reply, a draft can only acknowledge the
          customer, so it flags itself as <B>unsure of the facts</B>, and autopilot never sends an unsure draft.
        </P>
        <P>
          For each ticket, slai looks up the four most relevant enabled articles and saved replies (by the subject and
          the customer's latest message) and passes them to the draft. The draft links the articles it used, and you see
          them in Approvals.
        </P>
      </Section>

      <Section id="add" title="How to add knowledge">
        <Ul>
          <li>
            <B>Help-center articles.</B> When you connect a help desk that has a help center (Zendesk, Intercom,
            Freshdesk, Zammad, HubSpot), its published articles are synced automatically and refreshed daily. Admins can
            sync a source on demand from <AppLink to="/knowledge">Knowledge</AppLink>.
          </li>
          <li>
            <B>Saved replies (macros).</B> Many help desks' macros, canned responses or templates are synced as saved
            replies. Placeholders such as the requester's first name are removed, never filled in.
          </li>
          <li>
            <B>Write your own.</B> Admins can write saved replies on the Saved replies tab: the answers you give most
            often, like resetting SSO or finding invoices.
          </li>
          <li>
            <B>Switch items off.</B> Turn off an article that is outdated or internal, and drafts stop using it.
          </li>
        </Ul>
        <Callout title="Links in drafts">
          A link in an autopilot reply must appear in the thread or in your knowledge; any other link holds the draft
          for a person. Keeping article URLs in your knowledge lets drafts link to them.
        </Callout>
        <P>
          Related:{" "}
          <GuideLink to="autonomy" anchor="guardrails">
            the autopilot guardrails
          </GuideLink>
          .
        </P>
      </Section>
    </>
  );
}

export const knowledge: Guide = {
  id: "knowledge",
  title: "Knowledge",
  summary:
    "Why drafts need help-center articles or saved replies, how slai picks them for each ticket, and how to add or switch them off.",
  keywords: [
    "articles",
    "help center",
    "saved replies",
    "macros",
    "canned responses",
    "templates",
    "unsure",
    "facts",
    "sync",
  ],
  related: ["autonomy", "approvals", "connections"],
  sections: [
    { id: "why", title: "Why drafts need knowledge" },
    { id: "add", title: "How to add knowledge" },
  ],
  Body,
};
