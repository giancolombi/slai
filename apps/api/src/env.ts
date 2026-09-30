import { assertProductionEnv } from "@slai/db";
import { z } from "zod";
import { parseTrustProxy } from "./client-ip.js";

const base64Key = (name: string, minBytes: number) =>
  z
    .string({ error: `${name} is required (run \`pnpm setup:env\`)` })
    .refine((s) => Buffer.from(s, "base64").length >= minBytes, `${name} must be at least ${minBytes} bytes, base64`);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_URL: z.url(),
  API_URL: z.url(),
  /** RLS-restricted role (slai_app). All org data. */
  DATABASE_APP_URL: z.url(),
  /** systemDb role (slai_worker): webhook routing and pre-auth lookups only. */
  DATABASE_SYSTEM_URL: z.url(),
  /** authDb role (slai_auth): better-auth's identity tables (users, sessions, accounts, 2FA, passkeys, SSO). */
  DATABASE_AUTH_URL: z.url(),
  ENCRYPTION_KEY: base64Key("ENCRYPTION_KEY", 32),
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default("k1"),
  ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
  /** better-auth's secret: signs session cookies and seals TOTP secrets and backup codes. */
  SESSION_SECRET: base64Key("SESSION_SECRET", 32),
  /** The version of SESSION_SECRET; bump it when rotating and move the old one to SESSION_SECRETS_PREVIOUS. */
  SESSION_SECRET_VERSION: z.coerce.number().int().nonnegative().default(1),
  /** Retired secrets still accepted for reading: `version:secret[,version:secret]`. */
  SESSION_SECRETS_PREVIOUS: z.string().optional(),
  /**
   * Origins of internal IdPs (private hosts) that SSO may call, comma-separated.
   * Public IdPs need no entry. Operator-controlled; never set from the API.
   */
  SSO_TRUSTED_IDP_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** `s3` reads S3_* (see packages/db storage.ts); production requires it. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/uploads"),
  /**
   * Honor X-Forwarded-For for the client IP: false (default), true or a hop
   * count (proxies in front of the API), or trusted proxy CIDRs. See client-ip.ts.
   */
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      try {
        return typeof v === "boolean" ? v : parseTrustProxy(v);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: (e as Error).message });
        return z.NEVER;
      }
    }),
  /**
   * `memory` (per process) or `postgres` (shared by every replica). Run more
   * than one API replica only with `postgres` (TR-24a).
   */
  RATE_LIMIT_STORE: z.enum(["memory", "postgres"]).default("memory"),
});

export type Env = z.infer<typeof envSchema>;

/** Parses env and fails fast with every problem listed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  assertProductionEnv(source, "api");
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
