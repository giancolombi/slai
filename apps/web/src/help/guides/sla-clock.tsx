import { RISK_META, RiskBadge, SlaBar, SlaClock } from "@slai/ui";
import { B, Callout, Defs, GuideLink, H3, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

const HOUR = 3_600_000;
/** A fixed instant so the examples never tick. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Four examples of one 8-hour target: the bar fills against the warn ticks at 50% and 80%. */
function ClockExamples() {
  const target = 8 * HOUR;
  const rows = [
    { risk: "ok", elapsed: 2 * HOUR, state: "running", caption: "2h of 8h used" },
    { risk: "warning", elapsed: 4.5 * HOUR, state: "running", caption: "Past the first tick (50%)" },
    { risk: "at_risk", elapsed: 7 * HOUR, state: "running", caption: "Past the second tick (80%)" },
    { risk: "breached", elapsed: 9 * HOUR, state: "breached", caption: "Over the target" },
  ] as const;
  return (
    <figure className="rounded-md border border-line bg-surface p-4">
      <figcaption className="mb-3 text-xs text-ink-muted">
        One 8-hour resolution target at four moments. The ticks on each bar are the warning thresholds (50% and 80% by
        default; a policy can set its own).
      </figcaption>
      <ul className="flex flex-col gap-3.5">
        {rows.map((r) => (
          <li key={r.risk} className="grid grid-cols-[6.5rem_minmax(0,1fr)_7rem] items-center gap-3">
            <RiskBadge risk={r.risk} size="sm" />
            <div className="min-w-0">
              <SlaBar
                elapsedMs={r.elapsed}
                targetMs={target}
                risk={r.risk}
                label={`Example: ${RISK_META[r.risk].label}`}
                showScale
              />
              <span className="sr-only">{r.caption}</span>
            </div>
            <SlaClock
              dueAt={new Date(NOW + target - r.elapsed)}
              state={r.state}
              risk={r.risk === "ok" ? undefined : r.risk}
              size="sm"
              now={NOW}
              className="justify-self-end"
            />
          </li>
        ))}
        <li className="grid grid-cols-[6.5rem_minmax(0,1fr)_7rem] items-center gap-3">
          <span className="text-xs font-medium text-ink-muted">Paused</span>
          <SlaBar elapsedMs={3 * HOUR} targetMs={target} risk="ok" label="Example: paused" paused showScale />
          <SlaClock dueAt={null} state="paused" remainingMs={5 * HOUR} size="sm" className="justify-self-end" />
        </li>
      </ul>
    </figure>
  );
}

function Body() {
  return (
    <>
      <Section id="exact" title="A clock you can check">
        <P>
          Every SLA number in slai (due times, breaches, attainment, credits) is calculated exactly from your policy and
          the ticket's history, never guessed by AI. The same history always gives the same answer, and every breach
          shows the timeline, the policy version and the arithmetic behind it.
        </P>
      </Section>

      <Section id="metrics" title="The four metrics">
        <Defs
          rows={[
            [
              "First response",
              "Starts when the ticket is created. Stops at the first public reply from an agent (bot replies only count if the policy says so), or when the ticket is solved. Measured once.",
            ],
            [
              "Next response",
              "Starts when the customer writes again after the first response and no next-response clock is already running. Stops at the next public agent reply, or at solve. Can happen many times.",
            ],
            [
              "Periodic update",
              "Starts at the first response, restarts at every public agent reply and on reopen. Makes sure the customer hears from you at a steady rhythm. Stops at solve.",
            ],
            [
              "Resolution",
              "Starts when the ticket is created and stops when it is solved or closed. If the ticket is reopened, the same clock resumes: it does not start again from zero.",
            ],
          ]}
        />
        <P>
          A metric is only measured when the policy has a target for it at the ticket's priority. Internal notes never
          count as replies.
        </P>
      </Section>

      <Section id="clocks" title="Business hours or calendar time">
        <Ul>
          <li>
            <B>Calendar</B> clocks run 24x7.
          </li>
          <li>
            <B>Business</B> clocks only count the policy's weekly hours, in the policy's time zone, and skip its
            holidays. Each day uses its own local hours, so daylight-saving changes are handled.
          </li>
        </Ul>
        <P>Each target says which clock it uses, so a P1 can run 24x7 while a P3 counts business hours.</P>
      </Section>

      <Section id="risk" title="Warning, at risk, breached">
        <ClockExamples />
        <Defs
          rows={[
            [
              <RiskBadge key="ok" risk="ok" size="sm" />,
              "Less of the target is used than the first warning threshold.",
            ],
            [
              <RiskBadge key="w" risk="warning" size="sm" />,
              "Past the first threshold (50% of the target by default).",
            ],
            [
              <RiskBadge key="a" risk="at_risk" size="sm" />,
              "Past the second threshold (80% by default). A breach is close.",
            ],
            [
              <RiskBadge key="b" risk="breached" size="sm" />,
              "The time used is strictly more than the target. Exactly on target is still met.",
            ],
          ]}
        />
        <P>
          A ticket's risk is the worst risk among its metrics. Risk changes at the right instant even if nothing happens
          on the ticket: slai schedules the next change in advance.
        </P>
      </Section>

      <Section id="pauses" title="Pauses">
        <P>
          A policy can pause a metric while the ticket is in certain statuses, typically <B>pending</B> (waiting on the
          customer) or <B>on hold</B> (waiting on a third party). While paused, the clock keeps the time already used
          and shows how much is left.
        </P>
        <Callout title="Why a paused clock has no due time">
          A due time only exists while the clock runs. Nobody knows when the customer will answer, so slai cannot say
          when the ticket will breach. The clock shows the remaining time instead, and a due time returns the moment the
          ticket goes back to open.
        </Callout>
        <P>Solved and closed are never pause statuses: they stop clocks.</P>
      </Section>

      <Section id="priority" title="When the priority changes">
        <Ul>
          <li>
            A <B>running</B> clock is judged against the new priority's target, keeping the time already used. Raising a
            ticket to urgent can make it at risk, or breached, at once.
          </li>
          <li>
            A clock that already <B>stopped</B> keeps the priority it stopped with.
          </li>
          <li>
            A ticket with no priority uses the policy's default priority. If the policy has none, the ticket is not
            measured.
          </li>
        </Ul>
      </Section>

      <Section id="which-policy" title="Which policy measures a ticket">
        <P>
          Tickets are matched to a customer by their help-desk organization first, then by the most specific email
          domain. The customer's policy applies; tickets with no customer, or a customer without a policy, use the
          default policy. See{" "}
          <GuideLink to="faq" anchor="policy-not-applied">
            why a customer's policy may not apply
          </GuideLink>
          .
        </P>
        <H3>Attainment</H3>
        <P>
          Attainment is the share of clocks that met their target: met ÷ (met + breached). Clocks still running do not
          count yet.
        </P>
      </Section>
    </>
  );
}

export const slaClock: Guide = {
  id: "sla-clock",
  title: "How the SLA clock works",
  summary:
    "The four metrics, business and calendar clocks, pauses, reopens, priority changes, and what warning, at risk and breached mean.",
  keywords: [
    "first response",
    "next response",
    "periodic update",
    "resolution",
    "business hours",
    "calendar",
    "pause",
    "pending",
    "on hold",
    "reopen",
    "priority",
    "due",
    "risk",
    "warning",
    "at risk",
    "breached",
    "threshold",
    "attainment",
    "timer",
  ],
  related: ["contract-review", "alerts", "faq", "glossary"],
  sections: [
    { id: "exact", title: "A clock you can check" },
    { id: "metrics", title: "The four metrics" },
    { id: "clocks", title: "Business hours or calendar time" },
    { id: "risk", title: "Warning, at risk, breached" },
    { id: "pauses", title: "Pauses" },
    { id: "priority", title: "When the priority changes" },
    { id: "which-policy", title: "Which policy measures a ticket" },
  ],
  Body,
};
