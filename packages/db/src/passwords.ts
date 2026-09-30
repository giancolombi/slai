import { hash, verify } from "@node-rs/argon2";

/** `Algorithm.Argon2id` (an ambient const enum, which verbatimModuleSyntax cannot import). */
const ARGON2ID = 2;
/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). */
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/**
 * Verifies against a throwaway hash so that a login for an unknown email costs
 * the same as one for a known email (no user enumeration by timing).
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummy ??= hashPassword("slai-timing-equalizer-not-a-password");
  await verifyPassword(await dummy, password);
  return false;
}
