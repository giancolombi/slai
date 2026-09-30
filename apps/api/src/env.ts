import { z } from "zod";

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
  /**
   * OAuth apps for "Continue with <Provider>" (T-57). A provider's button is live only
   * when both its client id and secret are set; the redirect URI to register is
   * `${API_URL}/api/v1/connections/oauth/<provider>/callback`.
   */
  OAUTH_ZENDESK_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_ZENDESK_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_INTERCOM_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_INTERCOM_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_HUBSPOT_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_HUBSPOT_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_SALESFORCE_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_SALESFORCE_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_ZOHO_DESK_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_ZOHO_DESK_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_HELP_SCOUT_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_HELP_SCOUT_CLIENT_SECRET: z.string().min(1).optional(),
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/uploads"),
  /**
   * Stripe billing (T-65), test-mode keys in development. Without STRIPE_SECRET_KEY,
   * billing runs in manual mode (plans set by an admin via seed or POST /billing/manual).
   */
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  STRIPE_PRICE_STARTER: z.string().startsWith("price_").optional(),
  STRIPE_PRICE_GROWTH: z.string().startsWith("price_").optional(),
  STRIPE_PRICE_SCALE: z.string().startsWith("price_").optional(),
  /** Metered prices on the Billing Meters the worker reports overage to. */
  STRIPE_PRICE_TICKET_OVERAGE: z.string().startsWith("price_").optional(),
  STRIPE_PRICE_CREDIT_OVERAGE: z.string().startsWith("price_").optional(),
  /** Honor X-Forwarded-For for the client IP. Only enable behind a trusted proxy. */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

/** Parses env and fails fast with every problem listed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
