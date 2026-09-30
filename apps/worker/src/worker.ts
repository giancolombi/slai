import { PGBOSS_SCHEMA } from "@slai/db";
import { PgBoss } from "pg-boss";
import type { WorkerDeps } from "./deps.js";
import { createHandlers, handleJob, JOB_NAMES } from "./handlers.js";
import { errorMessage } from "./logger.js";

/** A pg-boss consumer: no schema creation or migration (that is `pnpm db:migrate`), no cron. */
export function createConsumerBoss(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    schedule: false,
    max: 5,
  });
}

/** Registers a handler for every queue. */
export async function registerHandlers(boss: PgBoss, deps: WorkerDeps, concurrency: number): Promise<void> {
  const handlers = createHandlers(deps);
  for (const name of JOB_NAMES) {
    await boss.work(
      name,
      {
        batchSize: 1,
        localConcurrency: concurrency,
        // One job per fetch keeps retries per job; poll fast and fetch back to back while there is a backlog.
        pollingIntervalSeconds: 0.5,
        burstWhenReadyExceeds: 1,
      },
      async (jobs) => {
        for (const job of jobs) {
          const started = Date.now();
          try {
            await handleJob(deps, handlers, name, job.data);
            deps.logger.debug({ job: name, id: job.id, ms: Date.now() - started }, "job done");
          } catch (e) {
            deps.logger.error({ job: name, id: job.id, err: errorMessage(e) }, "job failed");
            throw e;
          }
        }
      },
    );
  }
}
