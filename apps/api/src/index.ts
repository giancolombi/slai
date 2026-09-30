import { resolveTxt } from "node:dns/promises";
import { serve } from "@hono/node-server";
import { getConnector, listConnectors } from "@slai/connectors";
import {
  createAuthDb,
  createJobSender,
  createKeyring,
  createOrgDb,
  createProducerBoss,
  createStorage,
  createSystemDb,
} from "@slai/db";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createEventHub } from "./events-hub.js";
import { createLogger } from "./logger.js";
import { defaultRateLimits } from "./rate-limit.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const orgDb = createOrgDb(env.DATABASE_APP_URL, { applicationName: "slai-api" });
const systemDb = createSystemDb(env.DATABASE_SYSTEM_URL, { applicationName: "slai-api-system" });
const authDb = createAuthDb(env.DATABASE_AUTH_URL, { applicationName: "slai-api-auth" });
const boss = createProducerBoss(env.DATABASE_APP_URL);
boss.on("error", (err) => logger.error({ err: { message: err.message } }, "pg-boss error"));
await boss.start();

const app = createApp({
  env,
  orgDb,
  systemDb,
  authDb,
  resolveTxt,
  jobs: createJobSender(boss),
  storage: createStorage({ driver: env.STORAGE_DRIVER, localDir: env.STORAGE_LOCAL_DIR }),
  connectors: { get: getConnector, list: listConnectors },
  fetch: globalThis.fetch,
  keyring: createKeyring({
    key: env.ENCRYPTION_KEY,
    keyId: env.ENCRYPTION_KEY_ID,
    previous: env.ENCRYPTION_KEYS_PREVIOUS,
  }),
  logger,
  rateLimits: defaultRateLimits(),
  events: createEventHub(systemDb.client),
  now: () => new Date(),
  ready: async () => {
    await orgDb.client`select 1`;
    return true;
  },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "slai api listening");
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down");
  server.close();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  await Promise.all([orgDb.close(), systemDb.close(), authDb.close()]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
