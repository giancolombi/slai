import { AppLink, B, Callout, GuideLink, Ol, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="upload" title="Upload">
        <P>
          On <AppLink to="/contracts">Contracts</AppLink>, drop a PDF, DOCX, TXT or MD file (up to 20 MB) and, if you
          like, link it to a customer. slai reads it and extracts one draft policy per SLA schedule it finds: targets
          per metric and priority, business hours and time zone, holidays, pause rules and service-credit clauses. This
          takes about a minute. Nothing is measured against a draft.
        </P>
      </Section>

      <Section id="citations" title="Citations: every number, sourced">
        <P>
          Each extracted value carries a <B>citation</B>: the exact words from the contract it came from, with the page.
          Select a field to jump to its quote in the document. slai checks that each quote really appears in the
          document; a quote it cannot find is dropped, and the value it supported becomes a question instead.
        </P>
      </Section>

      <Section id="ambiguities" title="Questions (ambiguities) and why approval waits">
        <P>
          Contracts leave things open: "business hours" without a time zone, "priority 1" without saying what a P1 is, a
          credit with no cap. Wherever the contract does not settle a value, slai makes an assumption and asks you a
          question.
        </P>
        <Ol>
          <li>
            <B>Confirm the assumption</B> if it matches how you actually run support, or
          </li>
          <li>
            <B>Change the value</B> in the policy form. A change only counts once the value really differs from the
            extraction.
          </li>
        </Ol>
        <Callout title="Why you cannot approve with open questions">
          An unanswered question means slai would be guessing at a term that decides breaches and credits. Approval
          stays disabled until every question is confirmed or changed, so the clock never runs on a guess.
        </Callout>
      </Section>

      <Section id="approve" title="Approve, and versions">
        <Ul>
          <li>Only owners and admins approve. Every approval is recorded in the audit log.</li>
          <li>
            Approved policies are read-only. Editing one creates a new version; approving it replaces (supersedes) the
            previous version, which stays in the history.
          </li>
          <li>
            Before approving, <B>preview</B> a policy against your history: "this policy would have produced N breaches
            in the last 90 days".
          </li>
          <li>
            You can also write a policy by hand on <AppLink to="/policies">Policies</AppLink>.
          </li>
        </Ul>
      </Section>

      <Section id="assign" title="Assign it to customers">
        <P>
          A policy measures a customer's tickets once it is assigned to that customer on{" "}
          <AppLink to="/customers">Customers</AppLink>. Tickets are matched to customers by help-desk organization id
          first, then by the most specific email domain. Mark one policy as the <B>default</B> to measure everything
          else. A contract linked to a customer at upload makes the assignment easy to find, but you still choose the
          policy on the customer.
        </P>
        <P>
          Next: <GuideLink to="sla-clock">How the SLA clock works</GuideLink>.
        </P>
      </Section>
    </>
  );
}

export const contractReview: Guide = {
  id: "contract-review",
  title: "Reviewing a contract",
  summary:
    "Citations, the questions slai asks where a contract is ambiguous, why approval waits for them, versions, and assigning policies to customers.",
  keywords: [
    "contract",
    "upload",
    "extraction",
    "citation",
    "quote",
    "ambiguity",
    "question",
    "approve",
    "policy",
    "version",
    "supersede",
    "default policy",
    "preview",
    "msa",
    "sla schedule",
  ],
  related: ["sla-clock", "replay", "getting-started"],
  sections: [
    { id: "upload", title: "Upload" },
    { id: "citations", title: "Citations: every number, sourced" },
    { id: "ambiguities", title: "Questions (ambiguities) and why approval waits" },
    { id: "approve", title: "Approve, and versions" },
    { id: "assign", title: "Assign it to customers" },
  ],
  Body,
};
