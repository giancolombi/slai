/**
 * pg-boss queues shared by apps/api (producer) and apps/worker (consumer).
 * Payloads carry ids only (never ticket content or secrets); the worker loads
 * everything else through `withOrg(payload.orgId, ...)`.
 *
 * `send` enqueues inside the caller's transaction (pg-boss `fromDrizzle`), so a
 * job exists if and only if the row it refers to was committed.
 */
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { z } from "zod";
import type { Executor } from "./client.js";

const uuid = z.uuid();

export const JOB_PAYLOADS = {
  "sync-connection": z.object({ orgId: uuid, connectionId: uuid, full: z.boolean().default(false) }),
  "process-webhook": z.object({ orgId: uuid, connectionId: uuid, ticketSourceIds: z.array(z.string()).max(1000) }),
  "extract-contract": z.object({ orgId: uuid, contractId: uuid }),
  "run-agent": z.object({ orgId: uuid, runId: uuid }),
  "execute-action": z.object({ orgId: uuid, actionId: uuid }),
  "run-replay": z.object({ orgId: uuid, replayId: uuid }),
  "evaluate-ticket": z.object({ orgId: uuid, ticketId: uuid }),
  /** Fetch one ticket's history from the help desk and ingest it (from sync and webhooks). */
  "ingest-ticket": z.object({ orgId: uuid, connectionId: uuid, ticketSourceId: z.string().min(1).max(200) }),
  /** Page through one knowledge source's articles and upsert them (T-47). */
  "sync-knowledge": z.object({ orgId: uuid, sourceId: uuid }),
} as const;

export type JobName = keyof typeof JOB_PAYLOADS;
export type JobPayload<N extends JobName> = z.input<(typeof JOB_PAYLOADS)[N]>;
export const JOB_NAMES = Object.keys(JOB_PAYLOADS) as JobName[];

export const QUEUE = {
  syncConnection: "sync-connection",
  processWebhook: "process-webhook",
  extractContract: "extract-contract",
  runAgent: "run-agent",
  executeAction: "execute-action",
  runReplay: "run-replay",
  evaluateTicket: "evaluate-ticket",
  ingestTicket: "ingest-ticket",
  syncKnowledge: "sync-knowledge",
} as const satisfies Record<string, JobName>;

/** Parses a job's data in the worker (trust boundary). */
export function parseJob<N extends JobName>(name: N, data: unknown): z.output<(typeof JOB_PAYLOADS)[N]> {
  return JOB_PAYLOADS[name].parse(data) as z.output<(typeof JOB_PAYLOADS)[N]>;
}

export interface JobSender {
  /** Enqueues within `tx` (commit-coupled). Returns the job id. */
  send<N extends JobName>(tx: Executor, name: N, payload: JobPayload<N>): Promise<string | null>;
}

export const PGBOSS_SCHEMA = "pgboss";

/** A pg-boss instance for producers: no maintenance, no migrations, no cron. */
export function createProducerBoss(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
}

export function createJobSender(boss: PgBoss): JobSender {
  return {
    async send(tx, name, payload) {
      const data = JOB_PAYLOADS[name].parse(payload);
      return boss.send(name, data, { db: fromDrizzle(tx as never, sql as never) });
    },
  };
}

/** Installs/migrates the pg-boss schema and creates every queue. Run as the schema owner. */
export async function installJobQueues(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: ownerUrl, schema: PGBOSS_SCHEMA, supervise: false, schedule: false });
  boss.on("error", () => {});
  await boss.start();
  try {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    for (const name of JOB_NAMES) {
      if (!existing.has(name)) await boss.createQueue(name);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}
