import { AppLink, B, Callout, GuideLink, P, Section, Ul } from "../prose";
import type { Guide } from "../types";

function Body() {
  return (
    <>
      <Section id="channels" title="Channels">
        <P>
          Admins add channels in{" "}
          <AppLink to="/settings" hash="notifications">
            Settings → Notifications
          </AppLink>
          :
        </P>
        <Ul>
          <li>
            <B>Email</B>: any address, such as a team list or an on-call alias.
          </li>
          <li>
            <B>Slack</B>: an incoming-webhook URL for a channel. It is stored encrypted and only ever shown masked.
          </li>
        </Ul>
        <P>
          Each channel has a <B>minimum risk</B> (warning, at risk or breached; at risk by default) and can be switched
          off without deleting it. In the app itself, the dashboard, ticket list and ticket pages update live.
        </P>
      </Section>

      <Section id="when" title="When an alert is sent">
        <Ul>
          <li>When an open ticket crosses a channel's minimum risk, that channel gets one alert.</li>
          <li>
            Once per crossing: a ticket that stays at risk does not alert again. If it recovers (say a reply stops the
            clock and a new one starts) and crosses again, you hear about it again.
          </li>
          <li>Solved and closed tickets never alert.</li>
          <li>Every channel also hears when this month's AI spend reaches 50%, 80% and 100% of the cap (once each).</li>
        </Ul>
        <Callout title="Alerts are never throttled">
          Alerts, like the SLA clocks, run on every plan and in every billing state. They do not depend on autonomy.
        </Callout>
      </Section>

      <Section id="quiet" title="Why you did not get an alert">
        <Ul>
          <li>The ticket had not reached the channel's minimum risk, or the channel is switched off.</li>
          <li>The ticket already crossed that risk earlier: alerts are once per crossing.</li>
          <li>
            The ticket was already long overdue when the help desk was first connected. To avoid a flood on day one,
            only tickets still actionable at connect time alert (see{" "}
            <GuideLink to="autonomy" anchor="first-connect">
              Connecting does not flood you
            </GuideLink>
            ).
          </li>
          <li>
            The ticket is not measured at all: see{" "}
            <GuideLink to="faq" anchor="not-measured">
              Why is a ticket not measured?
            </GuideLink>
          </li>
        </Ul>
      </Section>
    </>
  );
}

export const alerts: Guide = {
  id: "alerts",
  title: "Alerts and notifications",
  summary: "Email and Slack channels, the minimum risk that triggers them, and why an alert is sent once per crossing.",
  keywords: [
    "alert",
    "notification",
    "email",
    "slack",
    "webhook",
    "channel",
    "minimum risk",
    "warning",
    "on-call",
    "notify",
  ],
  related: ["sla-clock", "autonomy", "faq"],
  sections: [
    { id: "channels", title: "Channels" },
    { id: "when", title: "When an alert is sent" },
    { id: "quiet", title: "Why you did not get an alert" },
  ],
  Body,
};
