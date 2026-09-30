import { auditEvents, memberships, passkeys, sessions, twoFactors, users } from "@slai/db";
import type { Me, MfaResetResult, Passkey, Role, SignInResult, StepUp } from "@slai/shared";

const expectResult = (r: MfaResetResult) => r;

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, Client, nextCode, PASSWORD, setupApp, signup } from "./harness.js";
import { SoftAuthenticator } from "./webauthn.js";

const ctx = setupApp();
const REASON = "HELP-123: verified on a video call with their manager";

type Person = Awaited<ReturnType<typeof signup>>;

/** A signed-up user who belongs only to `orgId` (their own signup org is left behind). */
async function onlyIn(orgId: string, role: Role, name: string = role): Promise<Person> {
  const p = await signup(ctx, name);
  await ctx.owner.db.insert(memberships).values({ orgId, userId: p.userId, role });
  await ctx.owner.db.delete(memberships).where(and(eq(memberships.userId, p.userId), eq(memberships.orgId, p.orgId)));
  const sw = await p.client.post("/auth/switch-org", { organizationId: orgId });
  if (sw.status !== 200) throw new Error(`switch failed ${sw.status}`);
  return { ...p, orgId };
}

/** Makes the step-up stale (as if the last TOTP/passkey proof was long ago). */
const staleStepUp = (userId: string) =>
  ctx.owner.db.update(sessions).set({ stepUpAt: null }).where(eq(sessions.userId, userId));

const reset = (actor: Client, userId: string, reason = REASON) =>
  actor.post(`/members/${userId}/reset-mfa`, { reason });

async function registerPasskey(client: Client, device: SoftAuthenticator) {
  const options = await client.get("/auth/passkey/generate-register-options");
  return client.post<Passkey>("/auth/passkey/verify-registration", { response: device.register(options.body) });
}

let owner: Person;
beforeAll(async () => {
  owner = await signup(ctx, "Owner");
});

describe("step-up (fresh TOTP or passkey within 5 minutes)", () => {
  it("is fresh right after a TOTP sign-in, and reported on /auth/me", async () => {
    const me = await owner.client.get<Me>("/auth/me");
    expect(me.body.security.stepUpUntil).not.toBeNull();
    expect(new Date(me.body.security.stepUpUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a reset without a fresh step-up, accepts one after a TOTP code, and expires after 5 minutes", async () => {
    const admin = await onlyIn(owner.orgId, "admin", "Stepper");
    const target = await onlyIn(owner.orgId, "member", "Target");
    await staleStepUp(admin.userId);

    const refused = await reset(admin.client, target.userId);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "step_up_required", details: { methods: ["totp"] } });

    const step = await admin.client.post<SignInResult>("/auth/two-factor/verify-totp", {
      code: nextCode(admin.totpSecret),
    });
    expect(step.status).toBe(200);
    if (step.body.status !== "signed_in") throw new Error("expected signed_in");
    expect(step.body.me.security.stepUpUntil).not.toBeNull();

    // Six minutes later the proof is stale again.
    ctx.clock.now = new Date(Date.now() + 6 * 60 * 1000);
    try {
      const expired = await reset(admin.client, target.userId);
      expect(expired.status).toBe(403);
      expect(expired.body.error.code).toBe("step_up_required");
    } finally {
      ctx.clock.now = null;
    }
    expect((await reset(admin.client, target.userId)).status).toBe(200);
  });

  it("a backup code is not a step-up", async () => {
    const admin = await onlyIn(owner.orgId, "admin", "Backup");
    const target = await onlyIn(owner.orgId, "member", "Target");
    await staleStepUp(admin.userId);
    const used = await admin.client.post("/auth/two-factor/verify-backup-code", { code: admin.backupCodes[0] });
    expect(used.status).toBe(200);
    expect((await reset(admin.client, target.userId)).body.error.code).toBe("step_up_required");
  });

  it("steps up with a passkey (user verification required); a foreign passkey is refused", async () => {
    const admin = await onlyIn(owner.orgId, "admin", "Keyholder");
    const target = await onlyIn(owner.orgId, "member", "Target");
    const device = new SoftAuthenticator(APP_URL);
    expect((await registerPasskey(admin.client, device)).status).toBe(200);
    await staleStepUp(admin.userId);

    const stranger = new SoftAuthenticator(APP_URL);
    const opts1 = await admin.client.get("/auth/step-up/passkey-options");
    expect(opts1.status).toBe(200);
    const bad = await admin.client.post("/auth/step-up/passkey", { response: stranger.authenticate(opts1.body) });
    expect(bad.status).toBe(401);

    const opts2 = await admin.client.get("/auth/step-up/passkey-options");
    const noUv = await admin.client.post("/auth/step-up/passkey", {
      response: device.authenticate(opts2.body, { userVerified: false }),
    });
    expect(noUv.status).toBe(401);
    expect((await reset(admin.client, target.userId)).body.error.code).toBe("step_up_required");

    const opts3 = await admin.client.get("/auth/step-up/passkey-options");
    const ok = await admin.client.post<StepUp>("/auth/step-up/passkey", { response: device.authenticate(opts3.body) });
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.stepUpUntil).getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    // The challenge is single use.
    const replay = await admin.client.post("/auth/step-up/passkey", { response: device.authenticate(opts3.body) });
    expect(replay.status).toBe(401);
    expect((await reset(admin.client, target.userId)).status).toBe(200);
  });
});

describe("admin reset of a member's second factors", () => {
  it("removes TOTP, backup codes and passkeys, revokes every session, forces re-enrollment, emails and audits", async () => {
    const admin = await onlyIn(owner.orgId, "admin", "Resetter");
    const target = await onlyIn(owner.orgId, "member", "Lost");
    const device = new SoftAuthenticator(APP_URL);
    expect((await registerPasskey(target.client, device)).status).toBe(200);
    const second = new Client(ctx);
    await second.post("/auth/sign-in/email", { email: target.email, password: PASSWORD });
    await second.post("/auth/two-factor/verify-totp", { code: nextCode(target.totpSecret) });
    expect((await second.get("/tickets")).status).toBe(200);

    const res = await reset(admin.client, target.userId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expectResult({
        userId: target.userId,
        removed: { totp: true, passkeys: 1 },
        sessionsRevoked: 2,
      }),
    );
    expect(await ctx.owner.db.select().from(twoFactors).where(eq(twoFactors.userId, target.userId))).toEqual([]);
    expect(await ctx.owner.db.select().from(passkeys).where(eq(passkeys.userId, target.userId))).toEqual([]);
    const [u] = await ctx.owner.db.select().from(users).where(eq(users.id, target.userId));
    expect(u!.mfaEnabled).toBe(false);
    // Every session is gone.
    expect((await target.client.get("/auth/me")).status).toBe(401);
    expect((await second.get("/auth/me")).status).toBe(401);
    // The old backup codes are useless, and the next sign-in is enrollment.
    const again = new Client(ctx);
    const signIn = await again.post<SignInResult>("/auth/sign-in/email", { email: target.email, password: PASSWORD });
    expect(signIn.body.status).toBe("mfa_enrollment_required");
    expect((await again.get("/tickets")).body.error.code).toBe("mfa_enrollment_required");
    expect((await again.post("/auth/two-factor/verify-backup-code", { code: target.backupCodes[1] })).status).not.toBe(
      200,
    );

    const [ev] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.mfa_reset"), eq(auditEvents.targetId, target.userId)));
    expect(ev).toMatchObject({ orgId: owner.orgId, actorId: admin.userId, actorName: admin.email, targetType: "user" });
    expect(ev!.metadata).toMatchObject({ reason: REASON, removed: { totp: true, passkeys: 1, sessions: 2 } });

    const jobs = await ctx.owner.db.execute<{ data: Record<string, unknown> }>(
      sql`select data from pgboss.job where name = 'send-security-email'`,
    );
    expect(jobs.map((j) => j.data)).toContainEqual({
      orgId: owner.orgId,
      userId: target.userId,
      kind: "mfa_reset",
      actorUserId: admin.userId,
    });
  });

  it("needs a reason, and is admin-only", async () => {
    const member = await onlyIn(owner.orgId, "member", "Plain");
    const target = await onlyIn(owner.orgId, "member", "Target");
    expect((await reset(member.client, target.userId)).status).toBe(403);
    const admin = await onlyIn(owner.orgId, "admin", "Terse");
    const short = await reset(admin.client, target.userId, "because");
    expect(short.status).toBe(400);
  });

  it("does not reset yourself", async () => {
    const admin = await onlyIn(owner.orgId, "admin", "Selfie");
    const res = await reset(admin.client, admin.userId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("self_reset");
  });

  it("an admin cannot reset an owner; another owner can", async () => {
    const coOwner = await onlyIn(owner.orgId, "owner", "CoOwner");
    const admin = await onlyIn(owner.orgId, "admin", "Climber");
    const denied = await reset(admin.client, coOwner.userId);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("cannot_reset_owner");
    const ok = await reset(owner.client, coOwner.userId);
    expect(ok.status).toBe(200);
  });

  it("never resets an organization's last owner (break-glass only)", async () => {
    const solo = await signup(ctx, "Solo");
    const admin = await onlyIn(solo.orgId, "admin", "Helper");
    const res = await reset(admin.client, solo.userId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("last_owner");
    expect(res.body.error.message).toMatch(/slai support/);
    expect(await ctx.owner.db.select().from(twoFactors).where(eq(twoFactors.userId, solo.userId))).toHaveLength(1);
  });

  it("refuses a member who also belongs to an org where the admin is not an admin", async () => {
    const other = await signup(ctx, "OtherOrg");
    const admin = await onlyIn(owner.orgId, "admin", "Scoped");
    const target = await onlyIn(owner.orgId, "member", "Shared");
    await ctx.owner.db.insert(memberships).values({ orgId: other.orgId, userId: target.userId, role: "member" });
    const denied = await reset(admin.client, target.userId);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("cross_org_member");
    expect(await ctx.owner.db.select().from(twoFactors).where(eq(twoFactors.userId, target.userId))).toHaveLength(1);

    // Admin in both orgs: allowed.
    await ctx.owner.db.insert(memberships).values({ orgId: other.orgId, userId: admin.userId, role: "admin" });
    expect((await reset(admin.client, target.userId)).status).toBe(200);
  });

  it("an admin elsewhere is not enough where the member is an owner", async () => {
    const other = await signup(ctx, "Twin");
    const admin = await onlyIn(owner.orgId, "admin", "Half");
    const target = await onlyIn(owner.orgId, "member", "Boss");
    // The target co-owns `other` (with its founder), where the admin is only an admin.
    await ctx.owner.db.insert(memberships).values({ orgId: other.orgId, userId: target.userId, role: "owner" });
    await ctx.owner.db.insert(memberships).values({ orgId: other.orgId, userId: admin.userId, role: "admin" });
    const denied = await reset(admin.client, target.userId);
    expect(denied.body.error.code).toBe("cross_org_member");
  });

  it("404s for someone outside the org", async () => {
    const stranger = await signup(ctx, "Stranger");
    const res = await reset(owner.client, stranger.userId);
    expect(res.status).toBe(404);
  });
});
