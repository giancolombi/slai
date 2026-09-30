/**
 * SAML end to end (T-19a) against an in-test IdP: the SP-initiated redirect,
 * then a signed assertion POSTed cross-site to the ACS the way a browser does it
 * (form-encoded, Origin = the IdP, Sec-Fetch-Site: cross-site, no X-Requested-With,
 * no slai cookie since it is SameSite=Lax). The assertions are built here and
 * signed with xml-crypto using the test keys in fixtures/saml.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { auditEvents, memberships, sessions, users } from "@slai/db";
import type { Me, OrgSsoSettings, SsoProvider } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { APP_URL, Client, dnsTxt, setupApp, signup } from "./harness.js";

const ctx = setupApp();
const fixture = (f: string) => readFileSync(new URL(`./fixtures/saml/${f}`, import.meta.url), "utf8");
const IDP = { key: fixture("idp.key"), cert: fixture("idp.crt") };
const ROGUE = { key: fixture("rogue.key"), cert: fixture("rogue.crt") };
const IDP_ENTITY = "https://idp.saml.test/entity";
const IDP_ORIGIN = "https://idp.saml.test";
const domain = `saml-${randomUUID().slice(0, 8)}.example`;
const PASSWORD_CTX = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
const MFA_CTX = "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract";

const certBody = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
const metadata = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ENTITY}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data>
      <ds:X509Certificate>${certBody(IDP.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_ORIGIN}/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

interface AuthnRequest {
  id: string;
  acs: string;
  audience: string;
  relayState: string;
}

/** Browser → slai: start SP-initiated SSO; returns what the IdP receives (redirect binding). */
async function startSso(client: Client, email: string): Promise<AuthnRequest> {
  const start = await client.post<{ url: string }>("/auth/sign-in/sso", { email });
  expect(start.status).toBe(200);
  const url = new URL(start.body.url);
  expect(url.origin + url.pathname).toBe(`${IDP_ORIGIN}/sso`);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  return {
    id: /\sID="([^"]+)"/.exec(xml)![1]!,
    acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)![1]!,
    audience: /<(?:\w+:)?Issuer[^>]*>([^<]+)</.exec(xml)![1]!,
    relayState: url.searchParams.get("RelayState")!,
  };
}

interface AssertionOpts {
  email: string;
  name?: string;
  signer?: { key: string; cert: string };
  audience?: string;
  notOnOrAfter?: Date;
  inResponseTo?: string;
  authnContext?: string;
}

/** IdP: a SAML Response with one signed Assertion. */
function samlResponse(req: AuthnRequest, o: AssertionOpts): string {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const exp = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60 * 1000);
  const inResponseTo = o.inResponseTo ?? req.id;
  const assertionId = `_a${randomUUID().replace(/-/g, "")}`;
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID().replace(/-/g, "")}" Version="2.0" IssueInstant="${iso(now)}" Destination="${req.acs}" InResponseTo="${inResponseTo}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${IDP_ENTITY}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(exp)}" Recipient="${req.acs}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(exp)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? req.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>${o.authnContext ?? PASSWORD_CTX}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>${o.name ?? "Saml User"}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const signer = o.signer ?? IDP;
  const sig = new SignedXml({
    privateKey: signer.key,
    publicCert: signer.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" },
  });
  return Buffer.from(sig.getSignedXml()).toString("base64");
}

/** The browser auto-submits the IdP's form: a cross-site top-level POST to the ACS. */
function postToAcs(client: Client, req: AuthnRequest, samlResponseB64: string, relayState = req.relayState) {
  return client.req("POST", req.acs, {
    csrf: false,
    body: new URLSearchParams({ SAMLResponse: samlResponseB64, RelayState: relayState }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: IDP_ORIGIN,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
}

const userByEmail = async (email: string) => (await ctx.owner.db.select().from(users).where(eq(users.email, email)))[0];

let admin: Awaited<ReturnType<typeof signup>>;
let provider: SsoProvider;

beforeAll(async () => {
  admin = await signup(ctx, "SamlAdmin");
  const created = await admin.client.post<SsoProvider>("/org/sso/providers", {
    protocol: "saml",
    name: "Test IdP",
    domains: [domain],
    metadataXml: metadata,
  });
  expect(created.status).toBe(201);
  provider = created.body;
  const rec = provider.domainVerification!;
  dnsTxt.set(`${rec.recordName}.${domain}`, [[rec.recordValue]]);
  expect((await admin.client.post(`/org/sso/providers/${provider.id}/verify-domain`)).status).toBe(200);
});

describe("SAML sign-in end to end (POST binding)", () => {
  it("accepts a signed assertion posted cross-site, sets a SameSite=Lax session and JIT-provisions a member", async () => {
    const email = `ana-${randomUUID().slice(0, 6)}@${domain}`;
    const browser = new Client(ctx);
    const req = await startSso(browser, email);
    expect(req.acs).toBe(provider.callbackUrl);

    const res = await postToAcs(browser, req, samlResponse(req, { email, name: "Ana Saml" }));
    expect(res.status).toBe(302);
    // Back to the app with a top-level GET, which carries a SameSite=Lax cookie.
    expect(res.headers.get("location")).toBe(`${APP_URL}/`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("slai_session="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await browser.get<Me>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ organization: { id: admin.orgId }, role: "member" });
    expect(me.body.security).toMatchObject({ authMethod: "sso", mfa: "satisfied", hasPassword: false });
    expect((await browser.get("/tickets")).status).toBe(200);

    const u = await userByEmail(email);
    expect(u!.name).toBe("Ana Saml");
    const rows = await ctx.owner.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, u!.id), eq(memberships.orgId, admin.orgId)));
    expect(rows.map((r) => r.role)).toEqual(["member"]);
    const [s] = await ctx.owner.db.select().from(sessions).where(eq(sessions.userId, u!.id));
    expect(s).toMatchObject({ authMethod: "sso", ssoOrgId: admin.orgId, idpAcr: PASSWORD_CTX });
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.actorId, u!.id));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["sso.jit_provisioned", "auth.login"]));
  });

  it("refuses the same assertion twice (replay)", async () => {
    const email = `replay-${randomUUID().slice(0, 6)}@${domain}`;
    const browser = new Client(ctx);
    const req = await startSso(browser, email);
    const assertion = samlResponse(req, { email });
    expect((await postToAcs(browser, req, assertion)).headers.get("location")).toBe(`${APP_URL}/`);
    const thief = new Client(ctx);
    const again = await postToAcs(thief, req, assertion);
    expect(again.headers.get("location") ?? "").not.toBe(`${APP_URL}/`);
    expect(thief.cookie).toBeNull();
  });

  const refused = async (label: string, build: (req: AuthnRequest, email: string) => string, relay?: string) => {
    const email = `${label}-${randomUUID().slice(0, 6)}@${domain}`;
    const browser = new Client(ctx);
    const req = await startSso(browser, email);
    const res = await postToAcs(browser, req, build(req, email), relay ?? req.relayState);
    expect(res.status, label).not.toBe(200);
    expect(res.headers.get("location") ?? "", label).not.toBe(`${APP_URL}/`);
    expect(browser.cookie, label).toBeNull();
    expect((await browser.get("/auth/me")).status, label).toBe(401);
    expect(await userByEmail(email), label).toBeUndefined();
    const [failed] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "auth.login_failed"), eq(auditEvents.targetId, provider.providerId)));
    expect(failed, label).toBeDefined();
    return res;
  };

  it("refuses an assertion signed by another key", async () => {
    await refused("forged", (req, email) => samlResponse(req, { email, signer: ROGUE }));
  });

  it("refuses an audience mismatch", async () => {
    await refused("audience", (req, email) => samlResponse(req, { email, audience: "https://another-sp.example/sp" }));
  });

  it("refuses an expired assertion", async () => {
    await refused("expired", (req, email) =>
      samlResponse(req, { email, notOnOrAfter: new Date(Date.now() - 10 * 60 * 1000) }),
    );
  });

  it("refuses an unsolicited response (unknown InResponseTo: IdP-initiated is off)", async () => {
    await refused("unsolicited", (req, email) => samlResponse(req, { email, inResponseTo: `_${randomUUID()}` }));
  });

  it("refuses a tampered RelayState", async () => {
    await refused("relay", (req, email) => samlResponse(req, { email }), "forged-relay-state");
  });

  it("refuses an identity outside the provider's verified domains", async () => {
    const browser = new Client(ctx);
    const req = await startSso(browser, `x@${domain}`);
    const outsider = `outsider-${randomUUID().slice(0, 6)}@elsewhere.example`;
    await postToAcs(browser, req, samlResponse(req, { email: outsider }));
    expect(browser.cookie).toBeNull();
    expect(await userByEmail(outsider)).toBeUndefined();
  });
});

describe("CSRF and the ACS", () => {
  it("exempts only the ACS: the same cross-site form POST elsewhere is rejected", async () => {
    for (const path of ["/auth/sign-in/email", "/auth/two-factor/verify-totp", "/auth/logout"]) {
      const res = await new Client(ctx).req("POST", path, {
        csrf: false,
        body: "SAMLResponse=x",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: IDP_ORIGIN,
          "sec-fetch-site": "cross-site",
        },
      });
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe("csrf");
    }
  });
});

describe("require the IdP to assert MFA (SAML AuthnContextClassRef)", () => {
  it("refuses a password-only context and accepts a two-factor one", async () => {
    const on = await admin.client.patch<OrgSsoSettings>("/org/sso", { requireIdpMfa: true });
    expect(on.body.requireIdpMfa).toBe(true);
    try {
      const weak = `weak-${randomUUID().slice(0, 6)}@${domain}`;
      const b1 = new Client(ctx);
      const r1 = await startSso(b1, weak);
      const res1 = await postToAcs(b1, r1, samlResponse(r1, { email: weak, authnContext: PASSWORD_CTX }));
      expect(res1.headers.get("location")).toBe(`${APP_URL}/login?sso_error=idp_mfa_required`);
      expect(b1.cookie).toBeNull();

      const strong = `strong-${randomUUID().slice(0, 6)}@${domain}`;
      const b2 = new Client(ctx);
      const r2 = await startSso(b2, strong);
      const res2 = await postToAcs(b2, r2, samlResponse(r2, { email: strong, authnContext: MFA_CTX }));
      expect(res2.headers.get("location")).toBe(`${APP_URL}/`);
      expect((await b2.get("/tickets")).status).toBe(200);
    } finally {
      await admin.client.patch("/org/sso", { requireIdpMfa: false });
    }
  });
});
