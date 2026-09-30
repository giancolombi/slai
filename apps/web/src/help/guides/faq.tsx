import type { ReactNode } from "react";
import { AppLink, B, GuideLink, P, Ul } from "../prose";
import type { Guide, HelpEntry } from "../types";

interface Faq {
  id: string;
  q: string;
  /** Extra search words. */
  keywords: string;
  a: ReactNode;
}

export const FAQS: Faq[] = [
  {
    id: "autopilot-not-sent",
    q: "Why didn't autopilot send this reply?",
    keywords: "autopilot blocked held guardrail flagged confidence needs human approvals",
    a: (
      <>
        <P>
          Autopilot only sends a draft that passes every guardrail. The reason it held one is shown on the draft in{" "}
          <AppLink to="/approvals">Approvals</AppLink>. The usual causes:
        </P>
        <Ul>
          <li>
            the draft flagged itself (a timeline promise, pricing or refunds, legal or security, or unsure of the
            facts);
          </li>
          <li>its confidence was below the rule's minimum;</li>
          <li>triage said the ticket needs a human;</li>
          <li>
            it contained a link or email address that is not in the thread or your knowledge, or something that looks
            like a secret or card number.
          </li>
        </Ul>
        <P>
          It may also never have been drafted: your plan (the trial has autopilot off), a failed payment or the spend
          cap can lower autonomy. "Unsure of the facts" usually means there was no relevant article: see{" "}
          <GuideLink to="knowledge">Knowledge</GuideLink> and <GuideLink to="autonomy">Choosing autonomy</GuideLink>.
        </P>
      </>
    ),
  },
  {
    id: "breached-replied",
    q: "Why is this ticket breached if we replied?",
    keywords: "breach reply internal note first response resolution late",
    a: (
      <>
        <P>Open the ticket: each metric shows its own clock, and the timeline shows the arithmetic. Common reasons:</P>
        <Ul>
          <li>
            The reply came after the target. Breach means strictly more time than the target; the due time is shown on
            the clock.
          </li>
          <li>
            It was an <B>internal note</B>, or a bot reply the policy does not count. Only public agent replies stop
            response clocks.
          </li>
          <li>
            A different metric breached: the reply met first response, but <B>resolution</B> or a <B>periodic update</B>{" "}
            ran out.
          </li>
          <li>
            The priority was raised: a running clock is judged against the new, shorter target, keeping the time already
            used.
          </li>
          <li>The ticket was reopened: resolution resumes the same clock, it does not restart.</li>
          <li>
            A custom status is mapped to Open where it should pause (see{" "}
            <GuideLink to="connections" anchor="mapping">
              status mapping
            </GuideLink>
            ).
          </li>
        </Ul>
      </>
    ),
  },
  {
    id: "not-measured",
    q: "Why is a ticket not measured?",
    keywords: "not measured no clock dash unmeasured missing policy priority",
    a: (
      <>
        <P>A ticket shows "—" instead of a clock when slai has nothing to measure it against:</P>
        <Ul>
          <li>no policy applies: its customer has no policy and there is no approved default policy;</li>
          <li>it has no priority and the policy has no default priority;</li>
          <li>
            the policy has no target for that metric at the ticket's priority (for example no resolution target for
            low).
          </li>
        </Ul>
        <P>
          Assign policies on <AppLink to="/customers">Customers</AppLink>, or approve a default policy on{" "}
          <AppLink to="/policies">Policies</AppLink>.
        </P>
      </>
    ),
  },
  {
    id: "policy-not-applied",
    q: "Why don't I see my customer's policy applied?",
    keywords: "customer policy wrong default match domain organization",
    a: (
      <>
        <Ul>
          <li>
            The policy is still a <B>draft</B>: only approved (active) policies measure tickets. Open questions on the
            contract block approval.
          </li>
          <li>
            The policy is not <B>assigned</B> to the customer on <AppLink to="/customers">Customers</AppLink>.
          </li>
          <li>
            The ticket did not <B>match</B> the customer. Matching uses the requester's help-desk organization first,
            then the most specific email domain. Add the customer's email domains or help-desk organizations. Unmatched
            tickets use the default policy.
          </li>
        </Ul>
      </>
    ),
  },
  {
    id: "training",
    q: "Is my customer data used to train AI?",
    keywords: "training privacy data model ai openai anthropic retention",
    a: (
      <P>
        No. slai's agents use commercial AI providers (Anthropic, with OpenAI as a fallback) under business terms that
        forbid training on your data. Agents never see your help-desk credentials. See{" "}
        <GuideLink to="team-security" anchor="data">
          how your data is protected
        </GuideLink>
        .
      </P>
    ),
  },
  {
    id: "paused-no-due",
    q: "Why does a paused clock have no due time?",
    keywords: "paused pending on hold due time remaining",
    a: (
      <P>
        While a ticket waits on the customer or a third party, nobody knows when the clock will start again, so there is
        no due time. slai shows the time left instead, and the due time returns when the ticket is open again. See{" "}
        <GuideLink to="sla-clock" anchor="pauses">
          Pauses
        </GuideLink>
        .
      </P>
    ),
  },
  {
    id: "no-drafts",
    q: "Why are there no drafts in Approvals?",
    keywords: "approvals empty no drafts assist observe",
    a: (
      <P>
        Drafts are only written under Assist or Autopilot rules, when a ticket reaches the rule's trigger risk, and when
        your plan allows drafts. With every rule on Observe, slai alerts but does not draft. See{" "}
        <GuideLink to="autonomy">Choosing autonomy</GuideLink>.
      </P>
    ),
  },
  {
    id: "does-slai-write",
    q: "Will slai change anything in my help desk?",
    keywords: "write back read only notes replies safe",
    a: (
      <P>
        Only under Assist or Autopilot rules (an internal note with the triage and draft, a reply when approved or when
        autopilot's guardrails pass) or when someone approves a draft. Priority and assignee suggestions are always
        proposals. Every write is in the audit log.
      </P>
    ),
  },
];

function Body() {
  return (
    <div className="flex flex-col gap-8">
      {FAQS.map((f) => (
        <section key={f.id} aria-labelledby={f.id} className="scroll-mt-20">
          <h2 id={f.id} className="mb-2 text-md font-semibold text-ink">
            {f.q}
          </h2>
          <div className="flex flex-col gap-3">{f.a}</div>
        </section>
      ))}
    </div>
  );
}

export const faqEntries: HelpEntry[] = FAQS.map((f) => ({
  guide: "faq",
  anchor: f.id,
  title: f.q,
  text: f.keywords,
}));

export const faq: Guide = {
  id: "faq",
  title: "FAQ",
  summary:
    "Quick answers: autopilot holds, breaches after a reply, unmeasured tickets, policies that don't apply, and AI training.",
  keywords: ["questions", "faq", "troubleshooting", "why"],
  related: ["sla-clock", "autonomy", "glossary"],
  sections: FAQS.map((f) => ({ id: f.id, title: f.q })),
  Body,
};
