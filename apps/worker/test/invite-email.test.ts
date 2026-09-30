import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AAD, auditEvents, encrypt, invitations, users } from "@slai/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createOrg, setupWorker } from "./harness.js";

const h = setupWorker();

/** An invitation as the API writes it: hash + sealed token. */
async function pendingInvite(orgId: string, opts: { revoked?: boolean } = {}) {
  const [inviter] = await h.owner.db
    .insert(users)
    .values({ email: `ada-${randomUUID()}@example.com`, name: "Ada Admin" })
    .returning();
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const email = `invitee-${randomUUID().slice(0, 6)}@example.com`;
  await h.owner.db.insert(invitations).values({
    id,
    orgId,
    email,
    role: "admin",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    tokenCiphertext: encrypt(token, { keyring: h.keyring, aad: AAD.invitationToken(id) }),
    invitedBy: inviter!.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    revokedAt: opts.revoked ? new Date() : null,
  });
  return { id, token, email };
}

describe("invitation emails (T-59a)", () => {
  it("emails the link with the token, then drops the sealed token, and audits", async () => {
    const orgId = await createOrg(h.owner);
    const inv = await pendingInvite(orgId);
    await h.queue.send("send-invite-email", { orgId, invitationId: inv.id });
    await h.drain(["send-invite-email"]);
    const mail = h.outbox.mail.find((m) => m.to === inv.email);
    expect(mail?.subject).toMatch(/You're invited to Org .* on slai/);
    expect(mail?.text).toContain(`${h.deps.config.appUrl}/invite/${inv.token}`);
    expect(mail?.text).toContain("Ada Admin invited you");
    expect(mail?.text).toContain("as an admin");
    const [row] = await h.owner.db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.tokenCiphertext).toBeNull();
    const [ev] = await h.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, inv.id), eq(auditEvents.action, "notification.sent")));
    expect(ev!.metadata).toMatchObject({ kind: "invitation", channelKind: "email" });
    expect(JSON.stringify(ev!.metadata)).not.toContain(inv.token);

    // A retry after success sends nothing (the token is gone).
    const before = h.outbox.mail.length;
    await h.queue.send("send-invite-email", { orgId, invitationId: inv.id });
    await h.drain(["send-invite-email"]);
    expect(h.outbox.mail.length).toBe(before);
  });

  it("sends nothing for a revoked invitation", async () => {
    const orgId = await createOrg(h.owner);
    const inv = await pendingInvite(orgId, { revoked: true });
    await h.queue.send("send-invite-email", { orgId, invitationId: inv.id });
    await h.drain(["send-invite-email"]);
    expect(h.outbox.mail.some((m) => m.to === inv.email)).toBe(false);
  });
});
