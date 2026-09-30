import { AppLink, B, Callout, Defs, GuideLink, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="replay" title="What Breach Replay does">
        <P>
          <AppLink to="/replay">Breach Replay</AppLink> reads the last N days of a connected help desk (90 by default,
          up to 180) and runs every ticket through your approved policies on the same clock that measures live tickets.
          It reports:
        </P>
        <Ul>
          <li>breaches and attainment for the period;</li>
          <li>credit exposure from your contracts' credit clauses, per customer and per metric;</li>
          <li>
            the <B>median warning</B>: how long before each breach slai would have flagged the ticket as at risk.
          </li>
        </Ul>
        <P>
          A replay sends no alerts and runs no agents. Only tickets an approved policy applies to (their customer's, or
          the default) are measured. A report can be printed or saved as a PDF from your browser.
        </P>
      </Section>

      <Section id="money" title="Attainment, credits and exposure">
        <Defs
          rows={[
            [
              "Attainment",
              "Met ÷ (met + breached) clocks, per scope and period. Clocks still running are not counted yet.",
            ],
            [
              "Per-breach credits",
              "A contract clause that pays a credit for each breached clock (a fixed amount or a % of the monthly fee).",
            ],
            [
              "Attainment credits",
              'Tiers such as "below 95%: 10% of the fee". The harshest tier that applies is used, not the sum.',
            ],
            ["Cap", "Credits can be capped at a % of the period's fee, as many contracts do."],
            [
              "Exposure",
              "The credits your contracts say you owe for the breaches in a period, per customer per calendar month, using each customer's monthly fee.",
            ],
          ]}
        />
        <Callout title="Set monthly fees on customers">
          Percent-of-fee credits need the customer's monthly fee. Add it on <AppLink to="/customers">Customers</AppLink>
          , or exposure for that customer shows as zero.
        </Callout>
      </Section>

      <Section id="dashboard" title="The money on the dashboard">
        <Ul>
          <li>
            <B>Breaches this period</B> and their <B>credit exposure</B>, computed the same way as in a replay.
          </li>
          <li>
            <B>Breaches saved</B>: clocks that were met while a slai reply or note had been sent during them, and the
            credits they would have cost had they breached.
          </li>
        </Ul>
        <P>
          All of these come from the deterministic clock and your contract terms, never from a model. See{" "}
          <GuideLink to="sla-clock">How the SLA clock works</GuideLink>.
        </P>
      </Section>
    </>
  );
}

export const replay: Guide = {
  id: "replay",
  title: "Breach Replay and money",
  summary:
    "Replay past tickets against your contracts, and how attainment, service credits and exposure are calculated.",
  keywords: [
    "replay",
    "history",
    "90 days",
    "credits",
    "service credits",
    "exposure",
    "attainment",
    "money",
    "cost",
    "saved",
    "report",
    "fee",
  ],
  related: ["sla-clock", "contract-review", "billing"],
  sections: [
    { id: "replay", title: "What Breach Replay does" },
    { id: "money", title: "Attainment, credits and exposure" },
    { id: "dashboard", title: "The money on the dashboard" },
  ],
  Body,
};
