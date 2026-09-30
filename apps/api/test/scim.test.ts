import { createHash, randomUUID } from "node:crypto";
import { auditEvents, memberships, scimTokens, sessions } from "@slai/db";
import type { Me, Member, ScimSettings, ScimTokenCreated, SsoProvider } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { entra, okta } from "./fixtures/scim.js";
import {
  addMember,
  Client,
  dnsTxt,
  enrollTotp,
  nextCode,
  PASSWORD,
  setupApp,
  signup,
  signupPending,
} from "./harness.js";

const ctx = setupApp();

// biome-ignore lint/suspicious/noExplicitAny: SCIM resources are asserted loosely
type Json = any;

/** An IdP's SCIM client: bearer token, application/scim+json. */
function scimClient(token: string | null) {
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { accept: "application/scim+json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/scim+json";
    const res = await ctx.app.request(`/scim/v2${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json, headers: res.headers };
  };
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b: unknown) => call("POST", p, b),
    put: (p: string, b: unknown) => call("PUT", p, b),
    patch: (p: string, b: unknown) => call("PATCH", p, b),
    del: (p: string) => call("DELETE", p),
  };
}

const SAML_METADATA = (entity: string) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data>
      <ds:X509Certificate>MIIBszCCAVmgAwIBAgIUXYZ</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

/** An org with a verified SSO domain and a SCIM token. */
async function scimOrg(name: string) {
  const admin = await signup(ctx, name);
  const domain = `${name.toLowerCase()}-${randomUUID().slice(0, 6)}.example`;
  const early = await admin.client.post("/org/scim/tokens", { name: "Okta" });
  expect(early.status).toBe(409);
  expect(early.body.error.code).toBe("sso_not_ready");
  const p = await admin.client.post<SsoProvider>("/org/sso/providers", {
    protocol: "saml",
    name: "IdP",
    domains: [domain],
    metadataXml: SAML_METADATA(`https://idp.example/${domain}`),
  });
  const rec = p.body.domainVerification!;
  dnsTxt.set(`${rec.recordName}.${domain}`, [[rec.recordValue]]);
  expect((await admin.client.post(`/org/sso/providers/${p.body.id}/verify-domain`)).status).toBe(200);
  const created = await admin.client.post<ScimTokenCreated>("/org/scim/tokens", { name: "Okta" });
  expect(created.status).toBe(201);
  return { admin, domain, token: created.body.token, tokenId: created.body.id, idp: scimClient(created.body.token) };
}

let acme: Awaited<ReturnType<typeof scimOrg>>;
beforeAll(async () => {
  acme = await scimOrg("Acme");
});

describe("SCIM tokens (SSO settings)", () => {
  it("shows the token once, stores only its sha256, lists a prefix, and audits", async () => {
    expect(acme.token).toMatch(/^slai_scim_[A-Za-z0-9_-]{43}$/);
    const settings = await acme.admin.client.get<ScimSettings>("/org/scim");
    expect(settings.status).toBe(200);
    expect(settings.body.baseUrl).toBe("http://localhost:8787/scim/v2");
    expect(settings.body.tokens).toHaveLength(1);
    expect(settings.body.tokens[0]).toMatchObject({ name: "Okta", prefix: acme.token.slice(0, 14), revokedAt: null });
    expect(JSON.stringify(settings.body)).not.toContain(acme.token);
    const [row] = await ctx.owner.db.select().from(scimTokens).where(eq(scimTokens.id, acme.tokenId));
    expect(row!.tokenHash).toBe(createHash("sha256").update(acme.token).digest("hex"));
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, acme.admin.orgId));
    expect(events.map((e) => e.action)).toContain("scim.token_created");
  });

  it("is admin-only", async () => {
    const member = await addMember(ctx, acme.admin.orgId, "member");
    expect((await member.client.get("/org/scim")).status).toBe(403);
    expect((await member.client.post("/org/scim/tokens", { name: "x" })).status).toBe(403);
  });

  it("refuses missing, wrong and revoked tokens with SCIM errors", async () => {
    const none = await scimClient(null).get("/Users");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/scim+json");
    expect(none.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect((await scimClient("slai_scim_nope").get("/Users")).status).toBe(401);

    const extra = await acme.admin.client.post<ScimTokenCreated>("/org/scim/tokens", { name: "Rotating" });
    const idp = scimClient(extra.body.token);
    expect((await idp.get("/Users")).status).toBe(200);
    expect((await acme.admin.client.del(`/org/scim/tokens/${extra.body.id}`)).status).toBe(204);
    expect((await idp.get("/Users")).status).toBe(401);
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, acme.admin.orgId));
    expect(events.map((e) => e.action)).toContain("scim.token_revoked");
  });

  it("keeps each org's SCIM data to itself", async () => {
    const other = await scimOrg("Globex");
    const user = await other.idp.post("/Users", okta.createUser(`iso-${randomUUID().slice(0, 6)}@${other.domain}`));
    expect(user.status).toBe(201);
    expect((await acme.idp.get(`/Users/${user.body.id}`)).status).toBe(404);
    expect((await acme.idp.patch(`/Users/${user.body.id}`, okta.setActive(false))).status).toBe(404);
    const list = await acme.idp.get("/Users");
    expect(list.body.Resources.map((r: Json) => r.id)).not.toContain(user.body.id);
    // Only the org's own verified domains can be provisioned.
    const foreign = await acme.idp.post("/Users", okta.createUser(`x-${randomUUID().slice(0, 6)}@${other.domain}`));
    expect(foreign.status).toBe(400);
    expect(foreign.body.scimType).toBe("invalidValue");
  });
});

describe("SCIM Users (Okta)", () => {
  it("creates, reads, filters, replaces, deactivates and reactivates a user", async () => {
    const email = `jane-${randomUUID().slice(0, 6)}@${acme.domain}`;
    expect((await acme.idp.get(okta.filterUser(email))).body).toMatchObject({ totalResults: 0, Resources: [] });

    const created = await acme.idp.post("/Users", okta.createUser(email));
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toContain("application/scim+json");
    expect(created.body).toMatchObject({
      userName: email,
      externalId: "00u1ab2cd3EfGh4ij5k6",
      displayName: "Jane Doe",
      active: true,
      emails: [{ value: email, primary: true }],
      meta: { resourceType: "User" },
    });
    expect(created.headers.get("location")).toBe(`http://localhost:8787/scim/v2/Users/${created.body.id}`);
    expect(JSON.stringify(created.body)).not.toContain("Tu3=zVf");
    const id = created.body.id as string;

    const dup = await acme.idp.post("/Users", okta.createUser(email));
    expect(dup.status).toBe(409);
    expect(dup.body.scimType).toBe("uniqueness");

    const found = await acme.idp.get(okta.filterUser(email.toUpperCase()));
    expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id }] });
    expect((await acme.idp.get(`/Users/${id}`)).body.userName).toBe(email);

    const replaced = await acme.idp.put(`/Users/${id}`, okta.replaceUser(id, email));
    expect(replaced.status).toBe(200);
    expect(replaced.body.displayName).toBe("Janet Doe");
    const renamed = await acme.idp.put(`/Users/${id}`, okta.replaceUser(id, `other@${acme.domain}`));
    expect(renamed.status).toBe(400);
    expect(renamed.body.scimType).toBe("mutability");

    const members = await acme.admin.client.get<{ items: Member[] }>("/members");
    expect(members.body.items.find((m) => m.email === email)).toMatchObject({
      role: "member",
      active: true,
      scimManaged: true,
    });

    const off = await acme.idp.patch(`/Users/${id}`, okta.setActive(false));
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const after = await acme.admin.client.get<{ items: Member[] }>("/members");
    expect(after.body.items.find((m) => m.email === email)?.active).toBe(false);

    const on = await acme.idp.patch(`/Users/${id}`, okta.setActive(true));
    expect(on.body.active).toBe(true);
    const actions = (await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, acme.admin.orgId))).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(["scim.user_provisioned", "scim.user_deactivated", "scim.user_reactivated"]),
    );
  });

  it("deactivation disables the membership and revokes the user's sessions in the org", async () => {
    // An existing slai user on the domain, linked by SCIM.
    const pending = await signupPending(ctx, "Linked", `linked-${randomUUID().slice(0, 6)}@${acme.domain}`);
    const { secret } = await enrollTotp(pending.client);
    const created = await acme.idp.post("/Users", okta.createUser(pending.email, "00uLINKED"));
    expect(created.status).toBe(201);
    expect((await pending.client.post("/auth/switch-org", { organizationId: acme.admin.orgId })).status).toBe(200);
    expect((await pending.client.get("/tickets")).status).toBe(200);

    const off = await acme.idp.patch(`/Users/${created.body.id}`, okta.setActive(false));
    expect(off.status).toBe(200);
    // The session acting in this org is gone...
    expect((await pending.client.get("/auth/me")).status).toBe(401);
    const left = await ctx.owner.db.select().from(sessions).where(eq(sessions.userId, pending.userId));
    expect(left).toEqual([]);
    const [m] = await ctx.owner.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, pending.userId), eq(memberships.orgId, acme.admin.orgId)));
    expect(m!.disabledAt).not.toBeNull();
    const [ev] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "scim.user_deactivated"), eq(auditEvents.targetId, pending.userId)));
    expect(ev).toMatchObject({ actorType: "system", actorName: "scim:Okta", actorId: acme.tokenId });
    expect(ev!.metadata).toMatchObject({ sessionsRevoked: 1 });

    // ...and signing in again cannot get back into the org.
    const again = new Client(ctx);
    await again.post("/auth/sign-in/email", { email: pending.email, password: PASSWORD });
    expect((await again.post("/auth/two-factor/verify-totp", { code: nextCode(secret) })).status).toBe(200);
    const me = await again.get<Me>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.organization.id).toBe(pending.orgId);
    expect(me.body.organizations.map((o) => o.id)).not.toContain(acme.admin.orgId);
    const sw = await again.post("/auth/switch-org", { organizationId: acme.admin.orgId });
    expect(sw.status).toBe(404);
  });

  it("a session still pointing at a deactivated org falls back to the user's other org", async () => {
    const pending = await signupPending(ctx, "Stale", `stale-${randomUUID().slice(0, 6)}@${acme.domain}`);
    await enrollTotp(pending.client);
    const created = await acme.idp.post("/Users", okta.createUser(pending.email, "00uSTALE"));
    expect((await acme.idp.patch(`/Users/${created.body.id}`, okta.setActive(false))).status).toBe(200);
    // E.g. a switch that raced the deactivation: the session row names the disabled org.
    await ctx.owner.db
      .update(sessions)
      .set({ activeOrgId: acme.admin.orgId })
      .where(eq(sessions.userId, pending.userId));
    const me = await pending.client.get<Me>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.organization.id).toBe(pending.orgId);
    expect(me.body.organizations.map((o) => o.id)).toEqual([pending.orgId]);
  });

  it("never deactivates or removes the org's last owner", async () => {
    const list = await acme.idp.get(okta.filterUser(acme.admin.email));
    const ownerId = list.body.Resources[0].id;
    const res = await acme.idp.patch(`/Users/${ownerId}`, okta.setActive(false));
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("mutability");
    expect((await acme.idp.del(`/Users/${ownerId}`)).status).toBe(400);
    expect((await acme.admin.client.get("/tickets")).status).toBe(200);
  });

  it("DELETE removes the member", async () => {
    const email = `gone-${randomUUID().slice(0, 6)}@${acme.domain}`;
    const created = await acme.idp.post("/Users", okta.createUser(email, "00uGONE"));
    expect((await acme.idp.del(`/Users/${created.body.id}`)).status).toBe(204);
    expect((await acme.idp.get(`/Users/${created.body.id}`)).status).toBe(404);
    expect((await acme.idp.get(okta.filterUser(email))).body.totalResults).toBe(0);
  });

  it("rejects filters it does not support", async () => {
    const res = await acme.idp.get(`/Users?filter=${encodeURIComponent('name.familyName co "Doe"')}`);
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidFilter");
  });
});

describe("SCIM Users (Entra ID)", () => {
  it("creates with the enterprise extension, disables with the string 'False', and patches attributes", async () => {
    const upn = `test.user-${randomUUID().slice(0, 6)}@${acme.domain}`;
    expect((await acme.idp.get(entra.filterUser(upn))).body.totalResults).toBe(0);
    const created = await acme.idp.post("/Users", entra.createUser(upn));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userName: upn, displayName: "Test User", active: true });
    const id = created.body.id as string;

    const upd = await acme.idp.patch(`/Users/${id}`, entra.updateAttributes(upn));
    expect(upd.status).toBe(200);
    expect(upd.body.displayName).toBe("Tess User");

    const off = await acme.idp.patch(`/Users/${id}`, entra.disable);
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    expect((await acme.idp.patch(`/Users/${id}`, entra.enable)).body.active).toBe(true);
  });

  it("does not rename a user who also belongs to another org", async () => {
    const shared = await signupPending(ctx, "Shared", `shared-${randomUUID().slice(0, 6)}@${acme.domain}`);
    const created = await acme.idp.post("/Users", entra.createUser(shared.email, "0aSHARED"));
    expect(created.body.displayName).toBe("Shared");
    const upd = await acme.idp.patch(`/Users/${created.body.id}`, entra.updateAttributes(shared.email));
    expect(upd.body.displayName).toBe("Shared");
  });
});

describe("SCIM Groups and group → role mapping", () => {
  it("Okta group push: a mapped group makes its members admins; removal reverts; owners are untouched", async () => {
    const map = await acme.admin.client.post("/org/scim/group-roles", { groupName: "slai-admins", role: "admin" });
    expect(map.status).toBe(201);
    const email = `lead-${randomUUID().slice(0, 6)}@${acme.domain}`;
    const user = await acme.idp.post("/Users", okta.createUser(email, "00uLEAD"));
    const ownerId = (await acme.idp.get(okta.filterUser(acme.admin.email))).body.Resources[0].id;

    const group = await acme.idp.post("/Groups", okta.createGroup("SLAI-Admins"));
    expect(group.status).toBe(201);
    expect(group.body).toMatchObject({ displayName: "SLAI-Admins", members: [] });
    expect((await acme.idp.post("/Groups", okta.createGroup("slai-admins"))).status).toBe(409);

    // A SCIM-provisioned user whom slai made an owner.
    const coOwnerEmail = `coowner-${randomUUID().slice(0, 6)}@${acme.domain}`;
    const coOwner = await acme.idp.post("/Users", okta.createUser(coOwnerEmail, "00uCOOWNER"));
    await ctx.owner.db.update(memberships).set({ role: "owner" }).where(eq(memberships.id, coOwner.body.id));

    const added = await acme.idp.patch(
      `/Groups/${group.body.id}`,
      okta.addMembers([user.body.id, ownerId, coOwner.body.id]),
    );
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: Json) => m.value).sort()).toEqual(
      [user.body.id, ownerId, coOwner.body.id].sort(),
    );
    const roleOf = async (e: string) =>
      (await acme.admin.client.get<{ items: Member[] }>("/members")).body.items.find((m) => m.email === e)?.role;
    expect(await roleOf(email)).toBe("admin");
    expect(await roleOf(acme.admin.email)).toBe("owner");
    expect(await roleOf(coOwnerEmail)).toBe("owner");
    await acme.idp.patch(`/Groups/${group.body.id}`, okta.removeMember(coOwner.body.id));
    expect(await roleOf(coOwnerEmail)).toBe("owner");
    expect((await acme.idp.get(`/Users/${user.body.id}`)).body.groups).toEqual([
      expect.objectContaining({ value: group.body.id, display: "SLAI-Admins" }),
    ]);

    const roleEvents = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, acme.admin.orgId), eq(auditEvents.action, "member.role_changed")));
    expect(roleEvents.some((e) => (e.metadata as Json).source === "scim" && (e.metadata as Json).to === "admin")).toBe(
      true,
    );

    // Renaming the group away from the mapping, and back.
    await acme.idp.patch(`/Groups/${group.body.id}`, okta.renameGroup(group.body.id, "Former Admins"));
    expect(await roleOf(email)).toBe("member");
    await acme.idp.patch(`/Groups/${group.body.id}`, okta.renameGroup(group.body.id, "slai-admins"));
    expect(await roleOf(email)).toBe("admin");

    const removed = await acme.idp.patch(`/Groups/${group.body.id}`, okta.removeMember(user.body.id));
    expect(removed.body.members.map((m: Json) => m.value)).toEqual([ownerId]);
    expect(await roleOf(email)).toBe("member");

    // Deleting a group recomputes its members.
    await acme.idp.patch(`/Groups/${group.body.id}`, okta.addMembers([user.body.id]));
    expect(await roleOf(email)).toBe("admin");
    expect((await acme.idp.del(`/Groups/${group.body.id}`)).status).toBe(204);
    expect(await roleOf(email)).toBe("member");
    expect((await acme.idp.get(`/Groups/${group.body.id}`)).status).toBe(404);
  });

  it("Entra group provisioning: externalId, filter with excludedAttributes, add and remove members", async () => {
    await acme.admin.client.post("/org/scim/group-roles", { groupName: "slai-viewers", role: "viewer" });
    const upn = `viewer-${randomUUID().slice(0, 6)}@${acme.domain}`;
    const user = await acme.idp.post("/Users", entra.createUser(upn, randomUUID()));
    const group = await acme.idp.post("/Groups", entra.createGroup("slai-viewers"));
    expect(group.status).toBe(201);
    expect(group.body.externalId).toBe("8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159");

    const found = await acme.idp.get(entra.filterGroup("slai-viewers"));
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources[0].members).toBeUndefined();

    await acme.idp.patch(`/Groups/${group.body.id}`, entra.addMember(user.body.id));
    const roleOf = async () =>
      (await acme.admin.client.get<{ items: Member[] }>("/members")).body.items.find((m) => m.email === upn)?.role;
    expect(await roleOf()).toBe("viewer");
    await acme.idp.patch(`/Groups/${group.body.id}`, entra.removeMember(user.body.id));
    expect(await roleOf()).toBe("member");
    const bad = await acme.idp.patch(`/Groups/${group.body.id}`, entra.addMember(randomUUID()));
    expect(bad.status).toBe(400);
  });

  it("changing a mapping in settings recomputes roles; owner cannot be mapped", async () => {
    const upn = `remap-${randomUUID().slice(0, 6)}@${acme.domain}`;
    const user = await acme.idp.post("/Users", okta.createUser(upn, "00uREMAP"));
    const group = await acme.idp.post("/Groups", okta.createGroup("support-leads"));
    await acme.idp.patch(`/Groups/${group.body.id}`, okta.addMembers([user.body.id]));
    const roleOf = async () =>
      (await acme.admin.client.get<{ items: Member[] }>("/members")).body.items.find((m) => m.email === upn)?.role;
    expect(await roleOf()).toBe("member");
    const mapped = await acme.admin.client.post("/org/scim/group-roles", { groupName: "Support-Leads", role: "admin" });
    expect(await roleOf()).toBe("admin");
    expect((await acme.admin.client.del(`/org/scim/group-roles/${mapped.body.id}`)).status).toBe(204);
    const owner = await acme.admin.client.post("/org/scim/group-roles", { groupName: "owners", role: "owner" });
    expect(owner.status).toBe(400);
    const settings = await acme.admin.client.get<ScimSettings>("/org/scim");
    expect(settings.body.groupRoles.map((r) => r.groupName)).toEqual(
      expect.arrayContaining(["slai-admins", "slai-viewers"]),
    );
  });
});
