import { randomUUID } from "node:crypto";
import { auditEvents, memberships, sessions, ssoProviders, users } from "@slai/db";
import type { Me, OrgSsoSettings, SignInDiscovery, SsoProvider } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { OAuth2Server } from "oauth2-mock-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_URL, addMember, Client, dnsTxt, PASSWORD, setupApp, signup, signupPending } from "./harness.js";

// A local OIDC IdP (no network beyond localhost). Started before the app so its
// origin can be allowlisted as an internal IdP (SSO_TRUSTED_IDP_ORIGINS).
const idp = new OAuth2Server();
await idp.issuer.keys.generate("RS256");
await idp.start(0, "localhost");
const idpUrl = idp.issuer.url!;
const ctx = setupApp({}, { SSO_TRUSTED_IDP_ORIGINS: [new URL(idpUrl).origin] });
afterAll(() => idp.stop());

const CLIENT_SECRET = `s3cret-${randomUUID()}`;
const domain = `sso-${randomUUID().slice(0, 8)}.example`;

/** The identity the IdP asserts (in the ID token, the access token and /userinfo). */
let identity = { sub: "", email: "", email_verified: true, name: "" };
/** How the IdP says it authenticated the user (ID token only). */
let authn: { amr?: string[]; acr?: string } = {};
idp.service.on("beforeTokenSigning", (token) => Object.assign(token.payload, identity, authn));
idp.service.on("beforeUserinfo", (res) => {
  res.body = { ...identity };
});
function asUser(email: string, name = "Jit User", how: typeof authn = {}) {
  identity = { sub: `sub-${email}`, email, email_verified: true, name };
  authn = how;
}

/** Runs the browser side of an OIDC login: discover → IdP → callback. Returns the callback response. */
async function ssoLogin(client: Client, email: string) {
  const discovered = await client.post<SignInDiscovery>("/auth/discover", { email });
  expect(discovered.body.method).toBe("sso");
  const start = await client.post<{ url: string }>("/auth/sign-in/sso", { email });
  expect(start.status).toBe(200);
  expect(start.body.url.startsWith(idpUrl)).toBe(true);
  const atIdp = await fetch(start.body.url, { redirect: "manual" });
  const callback = atIdp.headers.get("location")!;
  expect(callback).toContain("/api/v1/auth/sso/callback/");
  return client.get(callback);
}

let admin: Awaited<ReturnType<typeof signup>>;
let provider: SsoProvider;

beforeAll(async () => {
  admin = await signup(ctx, "Admin");
});

describe("SSO provider management (org admins)", () => {
  it("creates an OIDC provider from discovery, sealing the client secret and never returning it", async () => {
    const res = await admin.client.post<SsoProvider>("/org/sso/providers", {
      protocol: "oidc",
      name: "Acme Okta",
      domains: [domain],
      issuer: idpUrl,
      clientId: "slai-client",
      clientSecret: CLIENT_SECRET,
    });
    expect(res.status).toBe(201);
    provider = res.body;
    expect(provider).toMatchObject({
      protocol: "oidc",
      domains: [domain],
      domainVerified: false,
      clientId: "slai-client",
    });
    expect(provider.callbackUrl).toBe(`http://localhost:8787/api/v1/auth/sso/callback/${provider.providerId}`);
    expect(provider.domainVerification?.recordName).toBe("_slai-verification");
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
    const list = await admin.client.get<OrgSsoSettings>("/org/sso");
    expect(JSON.stringify(list.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(list.body)).not.toMatch(/clientSecret/);
    // Sealed at rest with the keyring (AES-256-GCM, key id k1).
    const [row] = await ctx.owner.db.select().from(ssoProviders).where(eq(ssoProviders.id, provider.id));
    expect(row!.oidcConfig).not.toContain(CLIENT_SECRET);
    expect(JSON.parse(row!.oidcConfig!).clientSecret).toMatch(/^v1\.k1\./);
    expect(row!.orgId).toBe(admin.orgId);
  });

  it("creates a SAML provider from metadata XML (URL or pasted) and returns the ACS URL", async () => {
    const xml = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.saml.example/entity">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data>
      <ds:X509Certificate>MIIBszCCAVmgAwIBAgIUXYZ</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.saml.example/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
    const bad = await admin.client.post("/org/sso/providers", {
      protocol: "saml",
      name: "Broken",
      domains: [`saml-${randomUUID().slice(0, 6)}.example`],
      metadataXml: "<nope/>",
    });
    expect(bad.status).toBe(422);
    const res = await admin.client.post<SsoProvider>("/org/sso/providers", {
      protocol: "saml",
      name: "Acme ADFS",
      domains: [`saml-${randomUUID().slice(0, 6)}.example`],
      metadataXml: xml,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ protocol: "saml", issuer: "https://idp.saml.example/entity", clientId: null });
    expect(res.body.callbackUrl).toBe(`http://localhost:8787/api/v1/auth/sso/saml2/sp/acs/${res.body.providerId}`);
    expect((await admin.client.del(`/org/sso/providers/${res.body.id}`)).status).toBe(204);
  });

  it("is admin-only", async () => {
    const member = await addMember(ctx, admin.orgId, "member");
    expect((await member.client.get("/org/sso")).status).toBe(403);
    expect((await member.client.post("/org/sso/providers", {})).status).toBe(403);
  });

  it("does not route sign-in to an unverified domain, and verifies it via DNS TXT", async () => {
    const d = await new Client(ctx).post<SignInDiscovery>("/auth/discover", { email: `x@${domain}` });
    expect(d.body).toEqual({ method: "password" });
    const missing = await admin.client.post(`/org/sso/providers/${provider.id}/verify-domain`);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("domain_not_verified");

    const rec = provider.domainVerification!;
    dnsTxt.set(`${rec.recordName}.${domain}`, [[rec.recordValue]]);
    const ok = await admin.client.post<SsoProvider>(`/org/sso/providers/${provider.id}/verify-domain`);
    expect(ok.status).toBe(200);
    expect(ok.body.domainVerified).toBe(true);
    expect(ok.body.domainVerification).toBeNull();
  });

  it("keeps providers isolated per org", async () => {
    const other = await signup(ctx, "Other");
    const theirs = await other.client.get<OrgSsoSettings>("/org/sso");
    expect(theirs.body.providers).toEqual([]);
    expect((await other.client.patch(`/org/sso/providers/${provider.id}`, { name: "pwned" })).status).toBe(404);
    expect((await other.client.del(`/org/sso/providers/${provider.id}`)).status).toBe(404);
    // A domain verified by one org cannot be claimed by another.
    const claim = await other.client.post("/org/sso/providers", {
      protocol: "oidc",
      name: "Squatter",
      domains: [domain],
      issuer: idpUrl,
      clientId: "x",
      clientSecret: "y",
    });
    expect(claim.status).toBe(409);
    expect(claim.body.error.code).toBe("domain_taken");
  });
});

describe("OIDC sign-in end to end", () => {
  it("discovers SSO by email domain, signs in at the IdP, and JIT-provisions a member", async () => {
    const email = `jit-${randomUUID().slice(0, 6)}@${domain}`;
    asUser(email);
    const client = new Client(ctx);
    const callback = await ssoLogin(client, email);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${APP_URL}/`);
    const me = await client.get<Me>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.organization.id).toBe(admin.orgId);
    expect(me.body.role).toBe("member");
    // The IdP's MFA is trusted by default.
    expect(me.body.security).toMatchObject({ authMethod: "sso", mfa: "satisfied", hasPassword: false });
    expect((await client.get("/tickets")).status).toBe(200);

    const [u] = await ctx.owner.db.select().from(users).where(eq(users.email, email));
    const rows = await ctx.owner.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, u!.id), eq(memberships.orgId, admin.orgId)));
    expect(rows.map((r) => r.role)).toEqual(["member"]);
    const audit = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.actorId, u!.id));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["sso.jit_provisioned", "auth.login"]));
    expect(audit.find((a) => a.action === "auth.login")!.metadata).toMatchObject({ method: "sso" });

    // A second login reuses the user and membership.
    asUser(email);
    const again = new Client(ctx);
    expect((await ssoLogin(again, email)).status).toBe(302);
    expect((await again.get<Me>("/auth/me")).body.role).toBe("member");
  });

  it("refuses an IdP identity outside the provider's verified domains", async () => {
    const email = `intruder-${randomUUID().slice(0, 6)}@elsewhere.example`;
    const client = new Client(ctx);
    const start = await client.post<{ url: string }>("/auth/sign-in/sso", { providerId: provider.providerId });
    asUser(email);
    const atIdp = await fetch(start.body.url, { redirect: "manual" });
    const res = await client.get(atIdp.headers.get("location")!);
    expect(res.headers.get("location")).toContain("sso_error");
    expect(client.cookie).toBeNull();
    expect(await ctx.owner.db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it("can also require slai MFA for SSO users (org setting, default off)", async () => {
    const email = `mfa-${randomUUID().slice(0, 6)}@${domain}`;
    asUser(email);
    const client = new Client(ctx);
    await ssoLogin(client, email);
    expect((await client.get("/tickets")).status).toBe(200);

    const on = await admin.client.patch<OrgSsoSettings>("/org/sso", { requireMfaForSso: true });
    expect(on.body.requireMfaForSso).toBe(true);
    const blocked = await client.get("/tickets");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("mfa_enrollment_required");
    // SSO users have no password: they enroll without one.
    const setup = await client.post("/auth/two-factor/enable", {});
    expect(setup.status).toBe(200);
    await admin.client.patch("/org/sso", { requireMfaForSso: false });
  });
});

describe("the IdP's MFA claims (amr/acr)", () => {
  const sessionOf = async (email: string) => {
    const [u] = await ctx.owner.db.select().from(users).where(eq(users.email, email));
    return ctx.owner.db.select().from(sessions).where(eq(sessions.userId, u!.id));
  };

  it("records amr and acr on the session and in the login audit event", async () => {
    const email = `amr-${randomUUID().slice(0, 6)}@${domain}`;
    asUser(email, "Amr User", { amr: ["pwd", "mfa", "otp"], acr: "urn:okta:loa:2fa:any" });
    const client = new Client(ctx);
    expect((await ssoLogin(client, email)).headers.get("location")).toBe(`${APP_URL}/`);
    const [s] = await sessionOf(email);
    expect(s).toMatchObject({ authMethod: "sso", idpAmr: ["pwd", "mfa", "otp"], idpAcr: "urn:okta:loa:2fa:any" });
    const [login] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, s!.userId), eq(auditEvents.action, "auth.login")));
    expect(login!.metadata).toMatchObject({ method: "sso", amr: ["pwd", "mfa", "otp"], acr: "urn:okta:loa:2fa:any" });
  });

  it("with 'require the IdP to assert MFA' on, refuses a sign-in without an MFA amr", async () => {
    const on = await admin.client.patch<OrgSsoSettings>("/org/sso", { requireIdpMfa: true });
    expect(on.status).toBe(200);
    expect(on.body.requireIdpMfa).toBe(true);
    try {
      const weak = `weak-${randomUUID().slice(0, 6)}@${domain}`;
      asUser(weak, "Weak", { amr: ["pwd"] });
      const c1 = new Client(ctx);
      const res = await ssoLogin(c1, weak);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP_URL}/login?sso_error=idp_mfa_required`);
      expect(c1.cookie).toBeNull();
      expect((await c1.get("/auth/me")).status).toBe(401);
      expect(await sessionOf(weak)).toEqual([]);
      const [failed] = await ctx.owner.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "auth.login_failed"), eq(auditEvents.actorName, weak)));
      expect(failed!.metadata).toMatchObject({ reason: "idp_mfa_missing", amr: ["pwd"] });

      // No amr at all is refused too.
      const none = `none-${randomUUID().slice(0, 6)}@${domain}`;
      asUser(none, "None");
      expect((await ssoLogin(new Client(ctx), none)).headers.get("location")).toContain("idp_mfa_required");

      // pwd + otp (two factor categories) is MFA.
      const strong = `strong-${randomUUID().slice(0, 6)}@${domain}`;
      asUser(strong, "Strong", { amr: ["pwd", "otp"] });
      const c2 = new Client(ctx);
      expect((await ssoLogin(c2, strong)).headers.get("location")).toBe(`${APP_URL}/`);
      expect((await c2.get("/tickets")).status).toBe(200);
    } finally {
      await admin.client.patch("/org/sso", { requireIdpMfa: false });
    }
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, admin.orgId));
    expect(events.map((e) => e.action)).toContain("sso.idp_mfa_policy_changed");
  });
});

describe("enforce SSO", () => {
  it("needs a verified provider, then blocks password sign-in (and signup) on the domain", async () => {
    const fresh = await signup(ctx, "Fresh");
    const notReady = await fresh.client.patch("/org/sso", { enforceSso: true });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe("sso_not_ready");

    // A password user on the SSO domain, created before enforcement.
    const pw = await signupPending(ctx, "Pw", `pw-${randomUUID().slice(0, 6)}@${domain}`);
    const before = await new Client(ctx).post("/auth/sign-in/email", { email: pw.email, password: PASSWORD });
    expect(before.status).toBe(200);

    const on = await admin.client.patch<OrgSsoSettings>("/org/sso", { enforceSso: true });
    expect(on.status).toBe(200);
    expect(on.body.enforceSso).toBe(true);
    const d = await new Client(ctx).post<SignInDiscovery>("/auth/discover", { email: pw.email });
    expect(d.body).toEqual({ method: "sso", providerId: provider.providerId, enforced: true });

    const blocked = await new Client(ctx).post("/auth/sign-in/email", { email: pw.email, password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("sso_required");
    const signupBlocked = await new Client(ctx).post("/auth/signup", {
      email: `new-${randomUUID().slice(0, 6)}@${domain}`,
      password: PASSWORD,
      name: "x",
      organizationName: "x",
    });
    expect(signupBlocked.body.error.code).toBe("sso_required");
    // Other domains are unaffected.
    const other = await new Client(ctx).post("/auth/sign-in/email", { email: admin.email, password: PASSWORD });
    expect(other.body.status).toBe("mfa_required");

    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, admin.orgId));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "sso.provider_created",
        "sso.domain_verified",
        "sso.enforcement_enabled",
        "sso.mfa_policy_changed",
      ]),
    );
    await admin.client.patch("/org/sso", { enforceSso: false });
  });

  it("updates and deletes providers with audit; deleting the last verified one lifts enforcement", async () => {
    const upd = await admin.client.patch<SsoProvider>(`/org/sso/providers/${provider.id}`, {
      name: "Acme Okta (prod)",
      clientSecret: `${CLIENT_SECRET}-2`,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe("Acme Okta (prod)");
    expect(upd.body.domainVerified).toBe(true);
    expect(JSON.stringify(upd.body)).not.toContain(CLIENT_SECRET);

    await admin.client.patch("/org/sso", { enforceSso: true });
    expect((await admin.client.del(`/org/sso/providers/${provider.id}`)).status).toBe(204);
    const after = await admin.client.get<OrgSsoSettings>("/org/sso");
    expect(after.body).toMatchObject({ enforceSso: false, providers: [] });
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, admin.orgId));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["sso.provider_updated", "sso.provider_deleted", "sso.enforcement_disabled"]),
    );
  });
});
