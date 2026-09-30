/**
 * Webhook signature helpers. Every comparison is constant-time over equal
 * length buffers (timingSafeEqual), and a length mismatch fails without an
 * early, data-dependent exit on content.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type HmacAlgo = "sha1" | "sha256";

export function hmac(algo: HmacAlgo, secret: string, payload: string, encoding: "hex" | "base64"): string {
  return createHmac(algo, secret).update(payload, "utf8").digest(encoding);
}

/** Constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against itself so the work done doesn't reveal the mismatch point.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verifies `signature` (optionally prefixed, e.g. "sha256=") against an HMAC of
 * `payload`. Hex comparisons are case-insensitive.
 */
export function verifyHmac(opts: {
  algo: HmacAlgo;
  secret: string;
  payload: string;
  signature: string | undefined | null;
  encoding: "hex" | "base64";
  prefix?: string;
}): boolean {
  if (!opts.signature || !opts.secret) return false;
  let sig = opts.signature.trim();
  if (opts.prefix) {
    if (!sig.toLowerCase().startsWith(opts.prefix.toLowerCase())) return false;
    sig = sig.slice(opts.prefix.length);
  }
  const expected = hmac(opts.algo, opts.secret, opts.payload, opts.encoding);
  return opts.encoding === "hex" ? safeEqual(sig.toLowerCase(), expected) : safeEqual(sig, expected);
}

/** Case-insensitive header lookup over a plain record. */
export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies an HS256 JWT (used by Atlassian for OAuth 2.0 dynamic webhooks).
 * Checks the signature and `exp`; returns the claims or null.
 */
export function verifyHs256Jwt(token: string, secret: string, nowMs: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let headerJson: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    headerJson = JSON.parse(b64urlDecode(h).toString("utf8"));
    claims = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    return null;
  }
  if (headerJson.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(s, expected)) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 < nowMs) return null;
  return claims;
}
