import { createHash, randomUUID } from "node:crypto";
import { AAD, auditEvents, decrypt, invitations, memberships } from "@slai/db";
import type { Invitation, InvitationPreview, Me, SignInResult, SsoProvider } from "@slai/shared";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, dnsTxt, enrollTotp, PASSWORD, setupApp, signup, signupPending } from "./harness.js";

const ctx = setupApp();

/** The raw token, as only the invite email carries it (sealed on the row until sent). */
async function tokenOf(invitationId: string): Promise<string> {
  const [row] = await ctx.owner.db.select().from(invitations).where(eq(invitations.id, invitationId));
  return decrypt(row!.tokenCiphertext!, { keyring: ctx.deps.keyring, aad: AAD.invitationToken(invitationId) });
}

let admin: Awaited<ReturnType<typeof signup>>;
beforeAll(async () => {
  admin = await signup(ctx, "Inviter");
});

async function invite(email: string, role: "admin" | "member" | "viewer" | "owner" = "member", by = admin.client) {
  const res = await by.post<Invitation>("/members/invite", { email, role });
  expect(res.status).toBe(201);
  const token = await tokenOf(res.body.id);
  expect(JSON.stringify(res.body)).not.toContain(token); // the API never returns it
  return { ...res.body, token };
}

const newEmail = (p: string) => `${p}-${randomUUID().slice(0, 8)}@example.com`;

describe("sending invitations", () => {
  it("stores only a hash and a sealed token, queues the email job with ids only, and audits", async () => {
    const email = newEmail("new");
    const inv = await invite(email, "admin");
    expect(inv).toMatchObject({ email, role: "admin", status: "pending", invitedBy: "Inviter" });
    const [row] = await ctx.owner.db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.tokenHash).toBe(createHash("sha256").update(inv.token).digest("hex"));
    expect(row!.tokenCiphertext).toMatch(/^v1\.k1\./);
    expect(row!.tokenCiphertext).not.toContain(inv.token);
    const jobs = await ctx.owner.db.execute<{ data: Record<string, unknown> }>(
      sql`select data from pgboss.job where name = 'send-invite-email'`,
    );
    expect(jobs.map((j) => j.data)).toContainEqual({ orgId: admin.orgId, invitationId: inv.id });
    const list = await admin.client.get<{ items: Invitation[] }>("/members/invitations");
    expect(list.body.items.find((i) => i.id === inv.id)?.status).toBe("pending");
  });

  it("previews by token only", async () => {
    const email = newEmail("peek");
    const inv = await invite(email, "viewer");
    const preview = await new Client(ctx).get<InvitationPreview>(`/auth/invitations/${inv.token}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      organization: { name: "Inviter Inc" },
      email,
      role: "viewer",
      invitedBy: "Inviter",
      status: "pending",
      account: "new",
      sso: null,
    });
    expect((await new Client(ctx).get(`/auth/invitations/${"x".repeat(43)}`)).status).toBe(404);
  });
});

describe("accepting as a new user", () => {
  it("signs up into the org with the invited role, then enrollment is mandatory; the token is single use", async () => {
    const email = newEmail("fresh");
    const inv = await invite(email, "admin");
    const client = new Client(ctx);
    const res = await client.post<SignInResult>(`/auth/invitations/${inv.token}/signup`, {
      name: "Fresh",
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    if (res.body.status !== "mfa_enrollment_required") throw new Error("expected enrollment");
    expect(res.body.me.organization.id).toBe(admin.orgId);
    expect(res.body.me.role).toBe("admin");
    expect(res.body.me.organizations).toHaveLength(1); // no org of their own
    expect((await client.get("/tickets")).body.error.code).toBe("mfa_enrollment_required");
    await enrollTotp(client);
    expect((await client.get("/tickets")).status).toBe(200);

    const again = await new Client(ctx).post(`/auth/invitations/${inv.token}/signup`, {
      name: "Again",
      password: PASSWORD,
    });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("invitation_used");
    const preview = await new Client(ctx).get<InvitationPreview>(`/auth/invitations/${inv.token}`);
    expect(preview.body).toMatchObject({ status: "accepted", account: "exists" });
    const [ev] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.invitation_accepted"), eq(auditEvents.targetId, inv.id)));
    expect(ev!.metadata).toMatchObject({ role: "admin", via: "signup" });
  });

  it("refuses signup for an email that already has an account", async () => {
    const existing = await signupPending(ctx, "Has");
    const inv = await invite(existing.email);
    const res = await new Client(ctx).post(`/auth/invitations/${inv.token}/signup`, { name: "x", password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_exists");
  });
});

describe("accepting as an existing user", () => {
  it("joins after a normal sign-in (MFA done), switches to the org, once", async () => {
    const user = await signup(ctx, "Existing");
    const inv = await invite(user.email, "viewer");
    const res = await user.client.post<Me>(`/auth/invitations/${inv.token}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(admin.orgId);
    expect(res.body.role).toBe("viewer");
    expect(res.body.organizations.map((o) => o.id).sort()).toEqual([admin.orgId, user.orgId].sort());
    const twice = await user.client.post(`/auth/invitations/${inv.token}/accept`);
    expect(twice.status).toBe(410);
    expect(twice.body.error.code).toBe("invitation_used");
  });

  it("requires the invited account, with MFA done", async () => {
    const invited = await signupPending(ctx, "Pending");
    const inv = await invite(invited.email);
    // Not enrolled yet: the MFA gate applies.
    const pending = await invited.client.post(`/auth/invitations/${inv.token}/accept`);
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe("mfa_enrollment_required");
    // Someone else's session cannot use the link.
    const other = await signup(ctx, "Other");
    const wrong = await other.client.post(`/auth/invitations/${inv.token}/accept`);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe("invitation_email_mismatch");
    expect((await new Client(ctx).post(`/auth/invitations/${inv.token}/accept`)).status).toBe(401);
  });

  it("promotes an existing member but never demotes", async () => {
    const member = await signup(ctx, "Member");
    await ctx.owner.db.insert(memberships).values({ orgId: admin.orgId, userId: member.userId, role: "member" });
    const down = await invite(member.email, "viewer");
    expect((await member.client.post<Me>(`/auth/invitations/${down.token}/accept`)).body.role).toBe("member");
    const up = await invite(member.email, "admin");
    expect((await member.client.post<Me>(`/auth/invitations/${up.token}/accept`)).body.role).toBe("admin");
  });

  it("does not let a member deactivated by the IdP back in", async () => {
    const gone = await signup(ctx, "Gone");
    await ctx.owner.db
      .insert(memberships)
      .values({ orgId: admin.orgId, userId: gone.userId, role: "member", disabledAt: new Date() });
    const inv = await invite(gone.email);
    const res = await gone.client.post(`/auth/invitations/${inv.token}/accept`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("membership_deactivated");
  });
});

describe("expiry, revoke and resend", () => {
  it("expires after 7 days", async () => {
    const user = await signup(ctx, "Late");
    const inv = await invite(user.email);
    const ttl = new Date(inv.expiresAt).getTime() - Date.now();
    expect(Math.abs(ttl - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
    // Seven days later (moved on the row: the user's own session would hit its 7-day limit).
    await ctx.owner.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(invitations.id, inv.id));
    expect((await new Client(ctx).get<InvitationPreview>(`/auth/invitations/${inv.token}`)).body.status).toBe(
      "expired",
    );
    const res = await user.client.post(`/auth/invitations/${inv.token}/accept`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("invitation_expired");
  });

  it("revoked invitations cannot be accepted or resent", async () => {
    const email = newEmail("revoked");
    const inv = await invite(email);
    expect((await admin.client.del(`/members/invitations/${inv.id}`)).status).toBe(204);
    const res = await new Client(ctx).post(`/auth/invitations/${inv.token}/signup`, { name: "x", password: PASSWORD });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("invitation_revoked");
    expect((await admin.client.post(`/members/invitations/${inv.id}/resend`)).status).toBe(409);
    const [row] = await ctx.owner.db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.tokenCiphertext).toBeNull();
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.targetId, inv.id));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["member.invited", "member.invitation_revoked"]),
    );
  });

  it("resend rotates the token and restarts the expiry", async () => {
    const email = newEmail("resend");
    const inv = await invite(email);
    const resent = await admin.client.post<Invitation>(`/members/invitations/${inv.id}/resend`);
    expect(resent.status).toBe(200);
    expect(resent.body.status).toBe("pending");
    const fresh = await tokenOf(inv.id);
    expect(fresh).not.toBe(inv.token);
    expect((await new Client(ctx).get(`/auth/invitations/${inv.token}`)).status).toBe(404);
    expect((await new Client(ctx).get(`/auth/invitations/${fresh}`)).status).toBe(200);
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.targetId, inv.id));
    expect(events.map((e) => e.action)).toContain("member.invitation_resent");
  });

  it("is admin-only", async () => {
    const inv = await invite(newEmail("guarded"));
    const member = await signup(ctx, "Nobody");
    await ctx.owner.db.insert(memberships).values({ orgId: admin.orgId, userId: member.userId, role: "member" });
    await member.client.post("/auth/switch-org", { organizationId: admin.orgId });
    expect((await member.client.get("/members/invitations")).status).toBe(403);
    expect((await member.client.del(`/members/invitations/${inv.id}`)).status).toBe(403);
    expect((await member.client.post(`/members/invitations/${inv.id}/resend`)).status).toBe(403);
  });
});

describe("enforce-SSO domains", () => {
  it("cannot accept through a password: no invite signup, no password sign-in, no accept from a password session", async () => {
    const domain = `inv-${randomUUID().slice(0, 8)}.example`;
    const p = await admin.client.post<SsoProvider>("/org/sso/providers", {
      protocol: "saml",
      name: "IdP",
      domains: [domain],
      metadataXml: `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example/${domain}"><md:IDPSSODescriptor><md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>MIIB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`,
    });
    expect(p.status).toBe(201);
    const rec = p.body.domainVerification!;
    dnsTxt.set(`${rec.recordName}.${domain}`, [[rec.recordValue]]);
    expect((await admin.client.post(`/org/sso/providers/${p.body.id}/verify-domain`)).status).toBe(200);

    // A password user on the domain, signed in before enforcement.
    const early = await signupPending(ctx, "Early", `early@${domain}`);
    await enrollTotp(early.client);
    expect((await admin.client.patch("/org/sso", { enforceSso: true })).status).toBe(200);
    try {
      const newcomer = await invite(`newcomer@${domain}`);
      const preview = await new Client(ctx).get<InvitationPreview>(`/auth/invitations/${newcomer.token}`);
      expect(preview.body.sso).toEqual({ providerId: p.body.providerId, enforced: true });
      const signupRes = await new Client(ctx).post(`/auth/invitations/${newcomer.token}/signup`, {
        name: "N",
        password: PASSWORD,
      });
      expect(signupRes.status).toBe(403);
      expect(signupRes.body.error.code).toBe("sso_required");

      const inv = await invite(early.email);
      const pw = await new Client(ctx).post("/auth/sign-in/email", { email: early.email, password: PASSWORD });
      expect(pw.body.error.code).toBe("sso_required");
      const accept = await early.client.post(`/auth/invitations/${inv.token}/accept`);
      expect(accept.status).toBe(403);
      expect(accept.body.error.code).toBe("sso_required");
      const [still] = await ctx.owner.db.select().from(invitations).where(eq(invitations.id, inv.id));
      expect(still!.acceptedAt).toBeNull();
    } finally {
      await admin.client.patch("/org/sso", { enforceSso: false });
    }
  });
});
