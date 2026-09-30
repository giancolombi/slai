/**
 * The worker's view of the job queue. Production uses pg-boss; tests use an
 * in-memory queue and drain it by calling the same handlers.
 */
import { type Executor, JOB_PAYLOADS, type JobName, type JobPayload } from "@slai/db";
import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";

export interface SendOptions {
  /** With `singletonSeconds`, at most one job per key per time slot. */
  singletonKey?: string;
  singletonSeconds?: number;
  startAfter?: Date;
  /** Enqueue inside this transaction (the job exists only if it commits). */
  tx?: Executor;
}

export interface JobQueue {
  send<N extends JobName>(name: N, payload: JobPayload<N>, opts?: SendOptions): Promise<void>;
}

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async send(name, payload, opts = {}) {
      const data = JOB_PAYLOADS[name].parse(payload);
      await boss.send(name, data, {
        ...(opts.singletonKey !== undefined && { singletonKey: opts.singletonKey }),
        ...(opts.singletonSeconds !== undefined && { singletonSeconds: opts.singletonSeconds }),
        ...(opts.startAfter !== undefined && { startAfter: opts.startAfter }),
        ...(opts.tx !== undefined && { db: fromDrizzle(opts.tx as never, sql as never) }),
      });
    },
  };
}
