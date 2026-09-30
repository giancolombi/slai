import { createServer } from "node:http";
import { createAgentRuntime } from "@slai/agents";
import { getConnector } from "@slai/connectors";
import { createKeyring, createOrgDb, createStorage, createSystemDb, s3OptionsFromEnv } from "@slai/db";
import { stripeUsageReporter } from "./billing-stripe.js";
import { systemClock } from "./clock.js";
import { DEFAULT_CONFIG, type WorkerDeps } from "./deps.js";
import { loadEnv } from "./env.js";
import { knowledgeResources } from "./knowledge.js";
import { createLogger, errorMessage } from "./logger.js";
import { smtpMailer } from "./notify.js";
import { bossQueue } from "./queue.js";
import { startSweep } from "./sweep.js";
import { createConsumerBoss, registerHandlers } from "./worker.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const orgDb = createOrgDb(env.DATABASE_APP_URL, { applicationName: "slai-worker", max: env.DB_POOL_APP });
const systemDb = createSystemDb(env.DATABASE_SYSTEM_URL, {
  applicationName: "slai-worker-sweep",
  max: env.DB_POOL_SYSTEM,
});
const boss = createConsumerBoss(env.DATABASE_APP_URL);
boss.on("error", (err) => logger.error({ err: errorMessage(err) }, "pg-boss error"));
await boss.start();

const deps: WorkerDeps = {
  orgDb,
  systemDb,
  queue: bossQueue(boss),
  clock: systemClock,
  keyring: createKeyring({
    key: env.ENCRYPTION_KEY,
    keyId: env.ENCRYPTION_KEY_ID,
    previous: env.ENCRYPTION_KEYS_PREVIOUS,
  }),
  connectors: { get: getConnector },
  fetch: globalThis.fetch,
  agents: createAgentRuntime({
    runtime: env.AGENT_RUNTIME,
    provider: env.MODEL_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    e2bApiKey: env.E2B_API_KEY,
    e2bTemplate: env.E2B_TEMPLATE,
  }),
  mailer: smtpMailer(env.SMTP_URL, env.EMAIL_FROM),
  storage: createStorage({
    driver: env.STORAGE_DRIVER,
    localDir: env.STORAGE_LOCAL_DIR,
    ...(env.STORAGE_DRIVER === "s3" && { s3: s3OptionsFromEnv() }),
  }),
  logger,
  resources: knowledgeResources({ orgDb }),
  usageReporter: env.STRIPE_SECRET_KEY ? stripeUsageReporter(env.STRIPE_SECRET_KEY) : null,
  config: {
    ...DEFAULT_CONFIG,
    sweepBatch: env.SWEEP_BATCH,
    syncIntervalMs: { demo: env.SYNC_INTERVAL_DEMO_SECONDS * 1000, other: env.SYNC_INTERVAL_SECONDS * 1000 },
    backfillDays: env.SYNC_BACKFILL_DAYS,
    appUrl: env.APP_URL,
    retention: {
      contentDays: env.RETENTION_CONTENT_DAYS,
      archivedContractDays: env.RETENTION_ARCHIVED_CONTRACT_DAYS,
    },
    retentionIntervalMs: env.RETENTION_INTERVAL_SECONDS * 1000,
    meters: { trackedTickets: env.STRIPE_METER_TRACKED_TICKETS, credits: env.STRIPE_METER_CREDITS },
    billingIntervalMs: env.BILLING_INTERVAL_SECONDS * 1000,
  },
};

await registerHandlers(boss, deps, env.WORKER_CONCURRENCY);
const sweep = startSweep(deps, env.SWEEP_INTERVAL_SECONDS * 1000);
logger.info(
  {
    runtime: env.AGENT_RUNTIME,
    provider: env.MODEL_PROVIDER,
    sweepSeconds: env.SWEEP_INTERVAL_SECONDS,
    billing: env.STRIPE_SECRET_KEY ? "stripe" : "manual",
  },
  "slai worker started",
);

// Liveness for container platforms: healthy while the sweep has succeeded recently.
const health =
  env.HEALTH_PORT > 0
    ? createServer((req, res) => {
        const last = sweep.lastOkAt();
        const ok = last !== null && Date.now() - last < Math.max(60_000, env.SWEEP_INTERVAL_SECONDS * 4000);
        res.writeHead(req.url === "/healthz" && ok ? 200 : req.url === "/healthz" ? 503 : 404, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok }));
      }).listen(env.HEALTH_PORT)
    : null;

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  health?.close();
  await sweep.stop();
  // Let in-flight jobs finish; unfinished ones are retried by pg-boss after expiry.
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
  await Promise.all([orgDb.close(), systemDb.close()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
