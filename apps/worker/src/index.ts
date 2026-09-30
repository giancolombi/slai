import { createAgentRuntime } from "@slai/agents";
import { getConnector } from "@slai/connectors";
import { createKeyring, createOrgDb, createStorage, createSystemDb } from "@slai/db";
import { systemClock } from "./clock.js";
import { DEFAULT_CONFIG, noResources, type WorkerDeps } from "./deps.js";
import { loadEnv } from "./env.js";
import { createLogger, errorMessage } from "./logger.js";
import { smtpMailer } from "./notify.js";
import { bossQueue } from "./queue.js";
import { startSweep } from "./sweep.js";
import { createConsumerBoss, registerHandlers } from "./worker.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const orgDb = createOrgDb(env.DATABASE_APP_URL, { applicationName: "slai-worker" });
const systemDb = createSystemDb(env.DATABASE_SYSTEM_URL, { applicationName: "slai-worker-sweep" });
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
  storage: createStorage({ driver: env.STORAGE_DRIVER, localDir: env.STORAGE_LOCAL_DIR }),
  logger,
  resources: noResources,
  config: {
    ...DEFAULT_CONFIG,
    sweepBatch: env.SWEEP_BATCH,
    syncIntervalMs: { demo: env.SYNC_INTERVAL_DEMO_SECONDS * 1000, other: env.SYNC_INTERVAL_SECONDS * 1000 },
    backfillDays: env.SYNC_BACKFILL_DAYS,
    appUrl: env.APP_URL,
  },
};

await registerHandlers(boss, deps, env.WORKER_CONCURRENCY);
const sweep = startSweep(deps, env.SWEEP_INTERVAL_SECONDS * 1000);
logger.info(
  { runtime: env.AGENT_RUNTIME, provider: env.MODEL_PROVIDER, sweepSeconds: env.SWEEP_INTERVAL_SECONDS },
  "slai worker started",
);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  await sweep.stop();
  // Let in-flight jobs finish; unfinished ones are retried by pg-boss after expiry.
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
  await Promise.all([orgDb.close(), systemDb.close()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
