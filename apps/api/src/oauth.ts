/**
 * OAuth connect flow helpers (T-57): the per-provider OAuth app config from
 * env, and the sealed `state` that carries the org, user, nonce, PKCE verifier
 * and provider params through the provider's redirect.
 *
 * The state is AES-256-GCM encrypted with the keyring (authenticated, so any
 * tampering fails to open, and confidential, so the PKCE verifier never leaves
 * slai in the clear). Its nonce must also match an httpOnly cookie set on the
 * browser that started the flow, which binds the callback to that browser.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptJson, encryptJson, type Keyring } from "@slai/db";
import { z } from "zod";
import type { Env } from "./env.js";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const OAUTH_NONCE_COOKIE = "slai_oauth_nonce";
const STATE_AAD = "oauth:connect-state";

/** The OAuth app slai registered with `provider`, or null when this deployment has none. */
export function oauthApp(env: Env, provider: string): { clientId: string; clientSecret: string } | null {
  const prefix = `OAUTH_${provider.toUpperCase()}`;
  if (!/^OAUTH_[A-Z_]+$/.test(prefix)) return null;
  const vars = env as unknown as Record<string, unknown>;
  const clientId = vars[`${prefix}_CLIENT_ID`];
  const clientSecret = vars[`${prefix}_CLIENT_SECRET`];
  return typeof clientId === "string" && typeof clientSecret === "string" && clientId && clientSecret
    ? { clientId, clientSecret }
    : null;
}

const stateSchema = z.object({
  provider: z.string(),
  orgId: z.uuid(),
  userId: z.string().min(1),
  nonce: z.string().min(16),
  verifier: z.string().nullable(),
  params: z.record(z.string(), z.string()),
  name: z.string().min(1).max(120),
  exp: z.number(),
});
export type OAuthState = z.infer<typeof stateSchema>;

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** RFC 7636 verifier (43+ chars) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function sealState(keyring: Keyring, state: OAuthState): string {
  return encryptJson(state, { keyring, aad: STATE_AAD });
}

/** Opens a sealed state; null when it was tampered with, is malformed, or has expired. */
export function openState(keyring: Keyring, sealed: string, now: number): OAuthState | null {
  try {
    const parsed = stateSchema.safeParse(decryptJson(sealed, { keyring, aad: STATE_AAD }));
    if (!parsed.success || parsed.data.exp < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function sameNonce(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
