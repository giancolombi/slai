import { GuideLink } from "../prose";
import { GUIDE_TITLES } from "../titles";
import type { Guide, GuideId, HelpEntry } from "../types";

interface Term {
  id: string;
  term: string;
  def: string;
  /** The guide that explains it in depth. */
  see?: GuideId;
}

export const TERMS: Term[] = [
  {
    id: "ambiguity",
    term: "Ambiguity",
    def: "A value the contract does not settle. slai assumes one and asks you to confirm or change it before the policy can be approved.",
    see: "contract-review",
  },
  {
    id: "assist",
    term: "Assist",
    def: "Autonomy level: agents triage and draft a reply for one-click approval; nothing is sent without a person.",
    see: "autonomy",
  },
  {
    id: "at-risk",
    term: "At risk",
    def: "Past the second warning threshold of a target (80% by default). A breach is close.",
    see: "sla-clock",
  },
  {
    id: "attainment",
    term: "Attainment",
    def: "Met ÷ (met + breached) SLA clocks in a scope and period.",
    see: "replay",
  },
  {
    id: "autopilot",
    term: "Autopilot",
    def: "Autonomy level: a draft is sent automatically when every guardrail passes; otherwise it waits in Approvals.",
    see: "autonomy",
  },
  { id: "breach", term: "Breach", def: "A clock that used strictly more time than its target.", see: "sla-clock" },
  {
    id: "breach-replay",
    term: "Breach Replay",
    def: "Past tickets replayed against your policies: breaches, attainment, credit exposure and how early slai would have warned.",
    see: "replay",
  },
  {
    id: "business-clock",
    term: "Business clock",
    def: "A clock that only counts the policy's business hours in its time zone, minus holidays.",
    see: "sla-clock",
  },
  { id: "calendar-clock", term: "Calendar clock", def: "A clock that runs 24x7.", see: "sla-clock" },
  {
    id: "citation",
    term: "Citation",
    def: "The exact contract text an extracted value came from, verified to appear in the document.",
    see: "contract-review",
  },
  {
    id: "credits-ai",
    term: "Credits (AI)",
    def: "Prepaid units for agent work: triage 3, draft 20, autopilot reply 60. 1 credit = $0.01.",
    see: "billing",
  },
  {
    id: "default-policy",
    term: "Default policy",
    def: "The approved policy used for tickets with no customer, or whose customer has no policy.",
    see: "contract-review",
  },
  {
    id: "exposure",
    term: "Exposure",
    def: "The service credits your contracts say you owe for the breaches in a period.",
    see: "replay",
  },
  {
    id: "guardrail",
    term: "Guardrail",
    def: "A check an autopilot draft must pass before it is sent: no flags, enough confidence, no human needed, no unknown links, no secrets.",
    see: "autonomy",
  },
  {
    id: "metric",
    term: "Metric",
    def: "What a clock measures: first response, next response, periodic update or resolution.",
    see: "sla-clock",
  },
  {
    id: "minimum-confidence",
    term: "Minimum confidence",
    def: "The confidence an autopilot draft needs to be sent (80% by default).",
    see: "autonomy",
  },
  {
    id: "observe",
    term: "Observe",
    def: "Autonomy level: alerts only. The default when no rule applies.",
    see: "autonomy",
  },
  {
    id: "pause",
    term: "Pause",
    def: "A metric stops counting while the ticket is in a pause status (often pending or on hold). It has no due time while paused.",
    see: "sla-clock",
  },
  {
    id: "policy",
    term: "Policy",
    def: "A contract's SLA terms as the rules slai measures tickets against: targets, business hours, pauses and credits. Versioned; approved by an admin.",
    see: "contract-review",
  },
  {
    id: "service-credit",
    term: "Service credit",
    def: "What a contract says you pay a customer for missing the SLA, per breach or by attainment tier.",
    see: "replay",
  },
  {
    id: "spend-cap",
    term: "Spend cap",
    def: "The most AI credits the organization uses in a month. At the cap, agents observe.",
    see: "billing",
  },
  {
    id: "tracked-ticket",
    term: "Tracked ticket",
    def: "A ticket with an SLA clock live during a calendar month. Plans are priced by tracked tickets.",
    see: "billing",
  },
  {
    id: "trigger",
    term: "Trigger",
    def: "The risk level at which an autonomy rule starts the agents on a ticket.",
    see: "autonomy",
  },
  {
    id: "warning",
    term: "Warning",
    def: "Past the first warning threshold of a target (50% by default).",
    see: "sla-clock",
  },
];

function Body() {
  return (
    <dl className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
      {TERMS.map((t) => (
        <div
          key={t.id}
          id={t.id}
          className="grid scroll-mt-20 gap-1 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
        >
          <dt className="text-sm font-semibold text-ink">{t.term}</dt>
          <dd className="text-sm leading-relaxed text-ink-muted">
            {t.def}
            {t.see && (
              <>
                {" "}
                <GuideLink to={t.see}>{GUIDE_TITLES[t.see]}</GuideLink>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const glossaryEntries: HelpEntry[] = TERMS.map((t) => ({
  guide: "glossary",
  anchor: t.id,
  title: t.term,
  text: t.def,
}));

export const glossary: Guide = {
  id: "glossary",
  title: "Glossary",
  summary: "Plain definitions of the words slai uses, from ambiguity to tracked ticket.",
  keywords: ["glossary", "terms", "definitions", "words", "meaning"],
  related: ["sla-clock", "faq", "getting-started"],
  sections: [],
  Body,
};
