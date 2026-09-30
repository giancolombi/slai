/**
 * The timer sweep (T-40) and sync scheduling. These are the only cross-org
 * queries in the worker; they run on systemDb (slai_worker), which can see
 * only scheduling columns, and hand each id to a job that uses withOrg.
 */
import { sql } from "drizzle-orm";
import type { WorkerDeps } from "./deps.js";

/**
 * Claims tickets whose `next_check_at` has passed and enqueues their
 * re-evaluation. The claim leases each ticket (pushes `next_check_at` forward)
 * in the same statement, so concurrent sweeps never double-claim and a lost
 * job is retried when the lease runs out; the evaluation sets the real timer.
 */
export async function sweepDueTickets(deps: WorkerDeps): Promise<number> {
  const now = deps.clock.now();
  const lease = new Date(now.getTime() + deps.config.leaseMs);
  const rows = await deps.systemDb.db.execute<{ id: string; org_id: string }>(sql`
    with due as (
      select id from tickets
      where next_check_at is not null and next_check_at <= ${now.toISOString()}::timestamptz
      order by next_check_at
      limit ${deps.config.sweepBatch}
      for update skip locked
    )
    update tickets t set next_check_at = ${lease.toISOString()}::timestamptz
    from due where t.id = due.id
    returning t.id, t.org_id`);
  for (const r of rows) {
    await deps.queue.send(
      "evaluate-ticket",
      { orgId: r.org_id, ticketId: r.id },
      { singletonKey: r.id, singletonSeconds: 15 },
    );
  }
  return rows.length;
}

/** Enqueues the periodic reconciliation sync for every active connection that is due. */
export async function scheduleSyncs(deps: WorkerDeps): Promise<number> {
  const now = deps.clock.now();
  const rows = await deps.systemDb.db.execute<{
    id: string;
    org_id: string;
    provider: string;
    last_sync_at: string | Date | null;
  }>(sql`select id, org_id, provider, last_sync_at from connections where status = 'active'`);
  let n = 0;
  for (const r of rows) {
    const interval = r.provider === "demo" ? deps.config.syncIntervalMs.demo : deps.config.syncIntervalMs.other;
    const last = r.last_sync_at ? new Date(r.last_sync_at).getTime() : null;
    if (last !== null && now.getTime() - last < interval) continue;
    await deps.queue.send(
      "sync-connection",
      { orgId: r.org_id, connectionId: r.id, full: false },
      { singletonKey: r.id, singletonSeconds: Math.max(1, Math.round(interval / 1000)) },
    );
    n++;
  }
  return n;
}

/**
 * Enqueues the retention job. pg-boss keeps one job per singleton slot, so with
 * several workers ticking it still runs once per interval.
 */
export async function scheduleRetention(deps: WorkerDeps): Promise<void> {
  const seconds = Math.max(60, Math.round(deps.config.retentionIntervalMs / 1000));
  await deps.queue.send("run-retention", {}, { singletonKey: "retention", singletonSeconds: seconds });
}

/** Runs the sweep and scheduling every `intervalMs`, never overlapping itself. */
export function startSweep(deps: WorkerDeps, intervalMs: number): { stop(): Promise<void>; lastOkAt(): number | null } {
  let running: Promise<void> | null = null;
  let lastOk: number | null = null;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const claimed = await sweepDueTickets(deps);
        const syncs = await scheduleSyncs(deps);
        await scheduleRetention(deps);
        lastOk = Date.now();
        if (claimed || syncs) deps.logger.debug({ claimed, syncs }, "sweep");
      } catch (e) {
        deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, "sweep failed");
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
    lastOkAt: () => lastOk,
  };
}
