import type { WorkerDeps } from "./deps.js";
import { enabledChannels, sendNotifications } from "./notify.js";

/** Alerts every enabled channel that the org crossed 50/80/100% of its monthly spend cap (T-46). */
export async function notifyCapThresholds(deps: WorkerDeps, orgId: string, percents: number[]): Promise<void> {
  if (!percents.length) return;
  const channels = await deps.orgDb.withOrg(orgId, (tx) => enabledChannels(tx));
  const top = Math.max(...percents);
  const text =
    top >= 100
      ? "This month's AI spend cap is used up. Agents have paused (alerts only) until next month or until an owner or admin raises the cap on Billing. SLA monitoring and alerts continue as normal."
      : `This month's AI spend has reached ${top}% of the cap. At 100%, agents pause (alerts only) until next month or until the cap is raised.`;
  await sendNotifications(
    deps,
    orgId,
    channels.map((c) => ({ id: c.id, kind: c.kind, target: c.target })),
    {
      subject: `[slai] ${top}% of the monthly AI spend cap used`,
      text: `${text}\n\nSee credits and the spend cap: ${deps.config.appUrl}/billing`,
    },
    { target: { type: "organization", id: orgId }, metadata: { capPercent: top } },
  );
}
