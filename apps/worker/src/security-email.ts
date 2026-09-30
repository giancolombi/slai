/**
 * Security emails to a user about their own account (T-19): today, that an
 * admin (or a break-glass operator) reset their second factors. The payload is
 * ids only; the address and names are read through withOrg. The delivery (or
 * failure) is audited like every other outbound message.
 */
import { audit, type JOB_PAYLOADS, memberships, organizations, users } from "@slai/db";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";

type Payload = z.output<(typeof JOB_PAYLOADS)["send-security-email"]>;

export async function sendSecurityEmail(deps: WorkerDeps, p: Payload): Promise<void> {
  const facts = await deps.orgDb.withOrg(p.orgId, async (tx) => {
    const [who] = await tx
      .select({ email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.userId, p.userId));
    const [org] = await tx.select({ name: organizations.name }).from(organizations);
    const [actor] = p.actorUserId
      ? await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, p.actorUserId))
      : [];
    return { who, org, actor };
  });
  if (!facts.who) return; // no longer a member of that org: nothing to say through it
  const by = facts.actor
    ? `${facts.actor.name} (${facts.actor.email}), an admin of ${facts.org?.name ?? "your organization"},`
    : "slai support, at your organization's request,";
  const text = [
    `Hi ${facts.who.name},`,
    "",
    `${by} reset the two-factor authentication on your slai account.`,
    "Your authenticator app, backup codes and passkeys were removed and you were signed out everywhere.",
    "The next time you sign in you will be asked to set up two-factor authentication again.",
    "",
    "If you did not ask for this, contact your administrator right away.",
    `${deps.config.appUrl}/login`,
  ].join("\n");
  let error: string | null = null;
  try {
    await deps.mailer.send({ to: facts.who.email, subject: "Your slai two-factor authentication was reset", text });
  } catch (e) {
    error = errorMessage(e);
    deps.logger.warn({ orgId: p.orgId, userId: p.userId, err: error }, "security email failed");
  }
  await deps.orgDb.withOrg(p.orgId, (tx) =>
    audit(tx, {
      orgId: p.orgId,
      actor: { type: "system", id: null, name: "slai" },
      action: error ? "notification.failed" : "notification.sent",
      target: { type: "user", id: p.userId },
      metadata: { kind: `security.${p.kind}`, channelKind: "email", ...(error && { error }) },
    }),
  );
  if (error) throw new Error(error); // pg-boss retries
}
