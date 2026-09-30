import { assertProductionEnv } from "@slai/db";
import { z } from "zod";

const base64Key = (name: string) =>
  z
    .string({ error: `${name} is required (run \`pnpm setup:env\`)` })
    .refine((s) => Buffer.from(s, "base64").length === 32, `${name} must be 32 bytes, base64`);

const seconds = (def: number) => z.coerce.number().int().positive().default(def);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_URL: z.url().default("http://localhost:5173"),
  /** RLS-restricted role (slai_app): all org data, always through withOrg. Also used for pg-boss. */
  DATABASE_APP_URL: z.url(),
  /** systemDb role (slai_worker): the cross-org timer sweep and sync scheduling only. */
  DATABASE_SYSTEM_URL: z.url(),
  ENCRYPTION_KEY: base64Key("ENCRYPTION_KEY"),
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default("k1"),
  ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
  /** `s3` reads S3_* (see packages/db storage.ts); production requires it. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/uploads"),
  SMTP_URL: z.string().min(1).default("smtp://localhost:1025"),
  EMAIL_FROM: z.string().min(1).default("slai <alerts@slai.local>"),
  MODEL_PROVIDER: z.enum(["mock", "anthropic", "openai"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AGENT_RUNTIME: z.enum(["local", "e2b"]).default("local"),
  E2B_API_KEY: z.string().optional(),
  E2B_TEMPLATE: z.string().optional(),
  /** Jobs each queue processes concurrently in this process. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),
  SWEEP_INTERVAL_SECONDS: seconds(15),
  SWEEP_BATCH: z.coerce.number().int().positive().max(10_000).default(500),
  SYNC_INTERVAL_DEMO_SECONDS: seconds(60),
  SYNC_INTERVAL_SECONDS: seconds(300),
  SYNC_BACKFILL_DAYS: z.coerce.number().int().positive().max(365).default(14),
  /** Retention (TR-30b): comment bodies and agent outputs older than this are purged; SLA outcomes stay. */
  RETENTION_CONTENT_DAYS: z.coerce.number().int().min(30).default(400),
  /** Archived contracts (row and file) are hard-deleted this many days after archiving. */
  RETENTION_ARCHIVED_CONTRACT_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_INTERVAL_SECONDS: seconds(3600),
  /** GET /healthz on this port (default $PORT, else 8788) answers 200 while the sweep loop is healthy. 0 disables. */
  HEALTH_PORT: z.coerce.number().int().nonnegative().default(8788),
  /** Stripe (T-65). Without a key, billing runs in manual mode and no usage is reported. */
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
  STRIPE_METER_TRACKED_TICKETS: z.string().min(1).default("slai_tracked_ticket_overage"),
  STRIPE_METER_CREDITS: z.string().min(1).default("slai_credit_overage"),
  BILLING_INTERVAL_SECONDS: seconds(3600),
});

export type Env = z.infer<typeof envSchema>;

/** Parses env and fails fast with every problem listed (never echoing values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  assertProductionEnv(source, "worker");
  const clean = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v]));
  // Platforms that health-check $PORT (e.g. Railway) get the health server there.
  clean.HEALTH_PORT ??= clean.PORT;
  const parsed = envSchema.safeParse(clean);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
