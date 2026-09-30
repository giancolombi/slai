/**
 * Envelope-free AES-256-GCM for secrets at rest (connector credentials, webhook
 * secrets, MFA secrets, Slack webhook URLs).
 *
 * Ciphertext format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts).
 * The key id lets us rotate: new writes use the current key, and reads look up
 * the key named in the ciphertext. To rotate, add the old key to
 * ENCRYPTION_KEYS_PREVIOUS (`id:base64,id:base64`) and set a new
 * ENCRYPTION_KEY/ENCRYPTION_KEY_ID; re-encrypt rows at leisure.
 *
 * Optional `aad` binds a ciphertext to its context (e.g. `connection:<id>`), so
 * a value copied into another row fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Keyring {
  currentId: string;
  keys: Map<string, Buffer>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function parseKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes, base64-encoded`);
  return key;
}

export function createKeyring(opts: { key: string; keyId: string; previous?: string }): Keyring {
  if (!KEY_ID.test(opts.keyId)) throw new Error("ENCRYPTION_KEY_ID must match [A-Za-z0-9_-]{1,32}");
  const keys = new Map<string, Buffer>();
  for (const entry of (opts.previous ?? "").split(",").filter(Boolean)) {
    const [id, b64] = entry.split(":");
    if (!id || !b64 || !KEY_ID.test(id)) throw new Error("ENCRYPTION_KEYS_PREVIOUS must be id:base64[,id:base64]");
    keys.set(id, parseKey(b64, `previous key ${id}`));
  }
  keys.set(opts.keyId, parseKey(opts.key, "ENCRYPTION_KEY"));
  return { currentId: opts.keyId, keys };
}

let envKeyring: Keyring | null = null;

/** The keyring from ENCRYPTION_KEY / ENCRYPTION_KEY_ID / ENCRYPTION_KEYS_PREVIOUS. */
export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  if (env === process.env && envKeyring) return envKeyring;
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set (run `pnpm setup:env`)");
  const ring = createKeyring({
    key: env.ENCRYPTION_KEY,
    keyId: env.ENCRYPTION_KEY_ID || "k1",
    previous: env.ENCRYPTION_KEYS_PREVIOUS,
  });
  if (env === process.env) envKeyring = ring;
  return ring;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function encrypt(plaintext: string, opts: { aad?: string; keyring?: Keyring } = {}): string {
  const ring = opts.keyring ?? keyringFromEnv();
  const key = ring.keys.get(ring.currentId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (opts.aad) cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", ring.currentId, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

export class DecryptError extends Error {}

export function decrypt(ciphertext: string, opts: { aad?: string; keyring?: Keyring } = {}): string {
  const ring = opts.keyring ?? keyringFromEnv();
  const parts = ciphertext.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") throw new DecryptError("unrecognized ciphertext format");
  const [, keyId, iv, tag, ct] = parts as [string, string, string, string, string];
  const key = ring.keys.get(keyId);
  if (!key) throw new DecryptError(`unknown encryption key id "${keyId}"`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    if (opts.aad) decipher.setAAD(Buffer.from(opts.aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptError("decryption failed");
  }
}

/** The key id a ciphertext was written with (for re-encryption sweeps). */
export function keyIdOf(ciphertext: string): string | null {
  const parts = ciphertext.split(".");
  return parts.length === 5 && parts[0] === "v1" ? (parts[1] ?? null) : null;
}

export const encryptJson = (value: unknown, opts?: { aad?: string; keyring?: Keyring }) =>
  encrypt(JSON.stringify(value), opts);
export const decryptJson = <T = unknown>(ciphertext: string, opts?: { aad?: string; keyring?: Keyring }): T =>
  JSON.parse(decrypt(ciphertext, opts)) as T;
