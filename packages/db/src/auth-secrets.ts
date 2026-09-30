/**
 * better-auth's secret configuration, shared by apps/api (the auth instance)
 * and the seed (which pre-enrolls the demo user in TOTP).
 *
 * better-auth seals TOTP secrets, backup codes and OAuth tokens with
 * XChaCha20-Poly1305 under a versioned secret (`$ba$<version>$<hex>`). We feed
 * it SESSION_SECRET as version 1; to rotate, put the new secret first with a
 * higher version and keep the old ones (SESSION_SECRETS_PREVIOUS) until rows
 * are re-sealed.
 */
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

export interface AuthSecret {
  version: number;
  value: string;
}

/** `current` is version 1 unless SESSION_SECRET_VERSION says otherwise; previous is `version:secret,...`. */
export function authSecrets(current: string, opts: { version?: number; previous?: string } = {}): AuthSecret[] {
  const out: AuthSecret[] = [{ version: opts.version ?? 1, value: current }];
  for (const entry of (opts.previous ?? "").split(",").filter(Boolean)) {
    const i = entry.indexOf(":");
    const version = Number(entry.slice(0, i));
    if (i < 1 || !Number.isInteger(version) || version < 0) {
      throw new Error("SESSION_SECRETS_PREVIOUS must be version:secret[,version:secret]");
    }
    out.push({ version, value: entry.slice(i + 1) });
  }
  return out;
}

function secretConfig(secrets: AuthSecret[]) {
  return {
    keys: new Map(secrets.map((s) => [s.version, s.value])),
    currentVersion: secrets[0]!.version,
  };
}

/** Seals `data` exactly as better-auth's twoFactor plugin does. */
export function sealForAuth(data: string, secrets: AuthSecret[]): Promise<string> {
  return symmetricEncrypt({ key: secretConfig(secrets), data });
}

export function openForAuth(data: string, secrets: AuthSecret[]): Promise<string> {
  return symmetricDecrypt({ key: secretConfig(secrets), data });
}
