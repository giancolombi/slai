/**
 * Invitation emails (T-59a). The payload is ids only: the token is read from the
 * invitation row, where the API sealed it (AES-256-GCM, AAD `invitation:<id>`),
 * and wiped after a successful send. A revoked, accepted or already-sent
 * invitation sends nothing. Every delivery (or failure) is audited.
 */
import { AAD, audit, decrypt, invitations, type JOB_PAYLOADS, organizations, users } from "@slai/db";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";

type Payload = z.output<(typeof JOB_PAYLOADS)["send-invite-email"]>;

const ROLE_NAME: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
  viewer: "a viewer",
};

export async function sendInviteEmail(deps: WorkerDeps, p: Payload): Promise<void> {
  const facts = await deps.orgDb.withOrg(p.orgId, async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, p.invitationId));
    const [org] = await tx.select({ name: organizations.name }).from(organizations);
    const [inviter] = inv?.invitedBy
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, inv.invitedBy))
      : [];
    return { inv, org, inviter };
  });
  const inv = facts.inv;
  if (!inv?.tokenCiphertext || inv.acceptedAt || inv.revokedAt) return;
  const token = decrypt(inv.tokenCiphertext, { keyring: deps.keyring, aad: AAD.invitationToken(inv.id) });
  const orgName = facts.org?.name ?? "an organization";
  const link = `${deps.config.appUrl}/invite/${encodeURIComponent(token)}`;
  const text = [
    `${facts.inviter?.name ?? "Someone"} invited you to join ${orgName} on slai as ${ROLE_NAME[inv.role] ?? inv.role}.`,
    "",
    `Accept the invitation: ${link}`,
    "",
    `The link works once and expires on ${inv.expiresAt.toUTCString()}.`,
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");

  let error: string | null = null;
  try {
    await deps.mailer.send({ to: inv.email, subject: `You're invited to ${orgName} on slai`, text });
  } catch (e) {
    error = errorMessage(e);
    deps.logger.warn({ orgId: p.orgId, invitationId: inv.id, err: error }, "invite email failed");
  }
  await deps.orgDb.withOrg(p.orgId, async (tx) => {
    // Drop the sealed token once sent, unless a resend rotated it meanwhile.
    if (!error) {
      await tx
        .update(invitations)
        .set({ tokenCiphertext: null })
        .where(and(eq(invitations.id, inv.id), eq(invitations.tokenCiphertext, inv.tokenCiphertext as string)));
    }
    await audit(tx, {
      orgId: p.orgId,
      actor: { type: "system", id: null, name: "slai" },
      action: error ? "notification.failed" : "notification.sent",
      target: { type: "invitation", id: inv.id },
      metadata: { kind: "invitation", channelKind: "email", ...(error && { error }) },
    });
  });
  if (error) throw new Error(error); // pg-boss retries
}
