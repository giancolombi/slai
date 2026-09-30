import { describe, expect, it } from "vitest";
import { idpAssertsMfa, oidcAuthn, samlAuthn } from "../src/auth/idp-mfa.js";

describe("idpAssertsMfa", () => {
  it.each([
    [{ amr: ["mfa"], acr: null }, true],
    [{ amr: ["pwd", "mfa"], acr: null }, true],
    [{ amr: ["pwd", "otp"], acr: null }, true],
    [{ amr: ["hwk", "pin"], acr: null }, true],
    [{ amr: ["swk", "fpt"], acr: null }, true],
    [{ amr: ["pwd"], acr: null }, false],
    [{ amr: ["otp"], acr: null }, false],
    [{ amr: ["pwd", "kba"], acr: null }, false],
    [{ amr: [], acr: null }, false],
    [{ amr: [], acr: "http://schemas.microsoft.com/claims/multipleauthn" }, true],
    [{ amr: [], acr: "https://refeds.org/profile/mfa" }, true],
    [{ amr: [], acr: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport" }, false],
  ])("%j → %s", (authn, expected) => {
    expect(idpAssertsMfa(authn)).toBe(expected);
  });
});

describe("claim extraction", () => {
  it("reads amr/acr from an ID token payload and ignores junk", () => {
    const jwt = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    expect(oidcAuthn(jwt({ amr: ["pwd", "mfa"], acr: "1" }))).toEqual({ amr: ["pwd", "mfa"], acr: "1" });
    expect(oidcAuthn(jwt({ amr: "mfa", acr: 3 }))).toEqual({ amr: [], acr: null });
    expect(oidcAuthn("not-a-jwt")).toEqual({ amr: [], acr: null });
    expect(oidcAuthn(undefined)).toEqual({ amr: [], acr: null });
  });

  it("reads the SAML AuthnContextClassRef from the posted response", () => {
    const xml = `<samlp:Response><saml:Assertion><saml:AuthnStatement><saml:AuthnContext>
      <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken</saml:AuthnContextClassRef>
      </saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
    const body = new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString("base64") }).toString();
    expect(samlAuthn(body)).toEqual({ amr: [], acr: "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken" });
    expect(samlAuthn("RelayState=x")).toEqual({ amr: [], acr: null });
  });
});
