import type { WorkerDeps } from "./deps.js";
import { enabledChannels, sendNotifications } from "./notify.js";

/** Alerts every enabled channel that the org crossed 50/80/100% of its monthly spend cap (T-46). */
export async function notifyCapThresholds(deps: WorkerDeps, orgId: string, percents: number[]): Promise<void> {
  if (!percents.length) return;
  const channels = await deps.orgDb.withOrg(orgId, (tx) => enabledChannels(tx));
  const top = Math.max(...percents);
  const text =
    top >= 100
      ? "This month's AI spend cap is used up. Agents are degraded to observe until next month or until the cap is raised. SLA monitoring and alerts continue."
      : `This month's AI spend has reached ${top}% of the cap.`;
  await sendNotifications(
    deps,
    orgId,
    channels.map((c) => ({ id: c.id, kind: c.kind, target: c.target })),
    {
      subject: `[slai] ${top}% of the monthly AI spend cap used`,
      text: `${text}\n\n${deps.config.appUrl}/settings/usage`,
    },
    { target: { type: "organization", id: orgId }, metadata: { capPercent: top } },
  );
}
