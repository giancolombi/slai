/**
 * What the IdP says about how it authenticated the user (T-19): OIDC `amr`
 * (RFC 8176) and `acr` from the verified ID token, or the SAML assertion's
 * AuthnContextClassRef. Recorded on the session and in the login audit event,
 * and enforced when the org turns on "require the IdP to assert MFA".
 */

export interface IdpAuthn {
  amr: string[];
  acr: string | null;
}

export const NO_IDP_AUTHN: IdpAuthn = { amr: [], acr: null };

// RFC 8176 method values by factor category.
const KNOWLEDGE = new Set(["pwd", "pin", "kba"]);
const POSSESSION = new Set(["otp", "hwk", "swk", "sms", "tel", "sc", "pop"]);
const INHERENCE = new Set(["fpt", "face", "iris", "retina", "vbm"]);

/** `acr` / AuthnContextClassRef values that mean multi-factor. */
const MFA_CONTEXTS = new Set([
  "https://refeds.org/profile/mfa",
  "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
  "http://schemas.microsoft.com/claims/multipleauthn",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI",
]);

/**
 * Did the IdP assert MFA? `amr` contains `mfa`, or methods from two different
 * factor categories (e.g. `pwd` + `otp`), or the context is a known MFA class.
 */
export function idpAssertsMfa(a: IdpAuthn): boolean {
  const amr = a.amr.map((m) => m.toLowerCase());
  if (amr.includes("mfa")) return true;
  const categories = [KNOWLEDGE, POSSESSION, INHERENCE].filter((set) => amr.some((m) => set.has(m))).length;
  if (categories >= 2) return true;
  return a.acr !== null && MFA_CONTEXTS.has(a.acr);
}

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

/** `amr`/`acr` from an ID token that better-auth has already verified against the IdP's JWKS. */
export function oidcAuthn(idToken: string | undefined): IdpAuthn {
  const payload = idToken?.split(".")[1];
  if (!payload) return NO_IDP_AUTHN;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const amr = Array.isArray(claims.amr) ? claims.amr.map((m) => str(m, 50)).filter((m) => m !== null) : [];
    return { amr: amr.slice(0, 20), acr: str(claims.acr) };
  } catch {
    return NO_IDP_AUTHN;
  }
}

/** AuthnContextClassRef from a SAML POST body (read only after better-auth validated the response). */
export function samlAuthn(formBody: string): IdpAuthn {
  const encoded = new URLSearchParams(formBody).get("SAMLResponse");
  if (!encoded) return NO_IDP_AUTHN;
  const xml = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8");
  const ref = /<(?:\w+:)?AuthnContextClassRef>\s*([^<\s]+)\s*</.exec(xml)?.[1];
  return { amr: [], acr: str(ref) };
}
