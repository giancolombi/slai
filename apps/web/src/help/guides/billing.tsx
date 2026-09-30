import { CREDIT_PACKS, OVERAGE_ALLOWANCE_PERCENT, PAST_DUE_GRACE_DAYS, PLAN_IDS, PLANS, TRIAL } from "@slai/shared";
import { formatMoney, formatNumber } from "@slai/ui";
import { AppLink, B, Callout, Defs, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

const CEILING_LABEL = {
  observe: "Observe (alerts only)",
  triage: "Observe + triage",
  assist: "Assist (drafts for approval)",
  autopilot: "Autopilot",
} as const;

/** The plan table, read from the same plans module the API and worker use. */
function PlanTable() {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <caption className="sr-only">Plans</caption>
        <thead className="border-b border-line bg-sunken/60 text-xs text-ink-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Plan
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Price / month
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Tracked tickets
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Included credits
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Agents may
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line text-ink-muted">
          {PLAN_IDS.map((id) => {
            const p = PLANS[id];
            return (
              <tr key={id}>
                <th scope="row" className="px-3 py-2 font-medium text-ink">
                  {p.name}
                </th>
                <td className="px-3 py-2 font-mono tnum">
                  {p.priceCents === null ? "By contract" : p.priceCents === 0 ? "Free" : formatMoney(p.priceCents)}
                </td>
                <td className="px-3 py-2 font-mono tnum">
                  {p.trackedTickets === null
                    ? "By contract"
                    : p.trackedTickets === 0
                      ? "Replay only"
                      : formatNumber(p.trackedTickets)}
                </td>
                <td className="px-3 py-2 font-mono tnum">{formatNumber(p.includedCredits)}</td>
                <td className="px-3 py-2">{CEILING_LABEL[p.ceiling]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Body() {
  const packs = CREDIT_PACKS.map((c) => `${formatNumber(c.credits)} for ${formatMoney(c.priceCents)}`).join(", ");
  return (
    <>
      <Section id="plans" title="Plans">
        <P>
          slai charges a platform fee by <B>SLA-tracked tickets</B>, plus prepaid <B>AI credits</B> for agent work.
          There is no per-seat price.
        </P>
        <PlanTable />
        <P>
          Every new organization starts on a <B>{TRIAL.days}-day Growth trial</B>: drafts for approval, autopilot off,{" "}
          {formatNumber(TRIAL.includedCredits)} credits, no card. If it ends without a plan, agents observe; monitoring
          and alerts continue.
        </P>
      </Section>

      <Section id="tracked" title="Tracked tickets">
        <P>
          A ticket counts <B>once per calendar month (UTC)</B> if any of its SLA clocks was live during that month:
          started before the month ended and not stopped before it began. A ticket open across two months counts in
          both. Tickets no policy measures are not tracked.
        </P>
        <Callout title="Over the limit, nothing stops">
          Monitoring never stops. The overage is shown on <AppLink to="/billing">Billing</AppLink>, the owner is emailed
          once a month, and each extra ticket is billed in arrears.
        </Callout>
      </Section>

      <Section id="credits" title="Credits">
        <Defs
          rows={[
            ["Triage", "3 credits"],
            ["Draft", "20 credits"],
            ["Autopilot reply", "60 credits"],
          ]}
        />
        <Ul>
          <li>1 credit = $0.01. Only successful runs use credits.</li>
          <li>
            Credits are used in this order: the plan's included credits, then purchased packs ({packs}; they never
            expire), then overage billed in arrears.
          </li>
          <li>
            The <B>spend cap</B> is included + purchased + {OVERAGE_ALLOWANCE_PERCENT}% of included by default; owners
            and admins can set their own. You get alerts at 50%, 80% and 100%. At the cap, agents observe until next
            month or until the cap is raised.
          </li>
          <li>
            A failed payment keeps your plan for {PAST_DUE_GRACE_DAYS} days; then agents observe until it is paid.
          </li>
        </Ul>
        <P>
          Everyone in the organization can see <AppLink to="/billing">Billing</AppLink>; owners and admins change plans,
          buy packs and manage payment methods.
        </P>
      </Section>
    </>
  );
}

export const billing: Guide = {
  id: "billing",
  title: "Billing",
  summary: "Plans, how tracked tickets are counted, AI credits and packs, the spend cap, and the trial.",
  keywords: [
    "plan",
    "price",
    "pricing",
    "trial",
    "tracked tickets",
    "overage",
    "credits",
    "credit pack",
    "spend cap",
    "invoice",
    "payment",
    "stripe",
    "upgrade",
    "starter",
    "growth",
    "scale",
    "enterprise",
  ],
  related: ["autonomy", "replay", "faq"],
  sections: [
    { id: "plans", title: "Plans" },
    { id: "tracked", title: "Tracked tickets" },
    { id: "credits", title: "Credits" },
  ],
  Body,
};
