/** Email-domain helpers for SSO discovery, JIT and enforce-SSO. */

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const d = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return d || null;
}

/** `sso_providers.domain` is comma-separated (better-auth's format). */
export function domainsOf(domain: string): string[] {
  return domain
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** The DNS TXT record an org publishes on each domain to prove ownership. */
export function domainVerificationRecord(token: string) {
  return { recordName: "_slai-verification", recordValue: `slai-verification=${token}` };
}
