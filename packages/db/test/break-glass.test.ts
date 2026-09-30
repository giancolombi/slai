import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { breakGlassReset } from "../src/mfa-reset.js";
import { auditEvents, memberships, passkeys, sessions, twoFactors, users } from "../src/schema.js";
import { openDbs, seedOrg, urls } from "./helpers.js";

const { owner } = openDbs();

/** A user with TOTP, a passkey and a session, owner of a fresh org. */
async function enrolledOwner() {
  const { orgId } = await seedOrg(owner, 0);
  const email = `owner-${randomUUID()}@example.com`;
  const [u] = await owner.db.insert(users).values({ email, name: "Solo Owner", mfaEnabled: true }).returning();
  await owner.db.insert(memberships).values({ orgId, userId: u!.id, role: "owner" });
  await owner.db.insert(twoFactors).values({ userId: u!.id, secret: "$ba$1$x", backupCodes: "$ba$1$y" });
  await owner.db.insert(passkeys).values({
    userId: u!.id,
    publicKey: "pk",
    credentialID: randomUUID(),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
  });
  await owner.db
    .insert(sessions)
    .values({ userId: u!.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  return { orgId, userId: u!.id, email };
}

describe("break-glass factor reset (T-19)", () => {
  it("refuses the runtime roles: it needs the database owner's credentials", async () => {
    const { email } = await enrolledOwner();
    for (const url of [urls.app, urls.auth, urls.system]) {
      await expect(breakGlassReset(url, { email, reason: "TICKET-1 verified by video call" })).rejects.toThrow(
        /database owner/,
      );
    }
  });

  it("requires a reason", async () => {
    const { email } = await enrolledOwner();
    await expect(breakGlassReset(urls.owner, { email, reason: "  " })).rejects.toThrow(/--reason/);
  });

  it("removes every factor and session, audits in each org, and queues the security email", async () => {
    const { orgId, userId, email } = await enrolledOwner();
    const r = await breakGlassReset(urls.owner, {
      email,
      reason: "TICKET-42 identity verified on a video call",
      operator: "oncall-ana",
    });
    expect(r).toMatchObject({ userId, orgIds: [orgId], totp: true, passkeys: 1, sessions: 1 });
    expect(await owner.db.select().from(twoFactors).where(eq(twoFactors.userId, userId))).toEqual([]);
    expect(await owner.db.select().from(passkeys).where(eq(passkeys.userId, userId))).toEqual([]);
    expect(await owner.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    const [u] = await owner.db.select().from(users).where(eq(users.id, userId));
    expect(u!.mfaEnabled).toBe(false);

    const [ev] = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "auth.mfa_break_glass_reset")));
    expect(ev).toMatchObject({ actorType: "system", actorName: "break-glass:oncall-ana", targetId: userId });
    expect(ev!.metadata).toMatchObject({
      reason: "TICKET-42 identity verified on a video call",
      operator: "oncall-ana",
    });

    const jobs = await owner.db.execute<{ data: { userId: string; kind: string } }>(
      sql`select data from pgboss.job where name = 'send-security-email'`,
    );
    expect(jobs.some((j) => j.data.userId === userId && j.data.kind === "mfa_reset")).toBe(true);
  });

  it("fails for an unknown email without touching anything", async () => {
    await expect(
      breakGlassReset(urls.owner, { email: `nobody-${randomUUID()}@example.com`, reason: "TICKET-7 checked id" }),
    ).rejects.toThrow(/no user/);
  });
});
