/**
 * Data retention and deletion (T-64, TR-30b). Runs hourly (the sweep enqueues
 * `run-retention` with a singleton key, so one run at a time across workers):
 *
 * - customer content older than `contentDays` (default 400): ticket comment
 *   bodies are blanked and agent run outputs and finished action bodies are
 *   cleared. Tickets, events and `sla_outcomes` stay, so SLA history, attainment
 *   and credits are unchanged;
 * - archived contracts older than `archivedContractDays`: the file and the row
 *   are hard-deleted;
 * - expired export bundles, expired unaccepted invitations;
 * - expired sessions, verification tokens and idle rate-limit buckets
 *   (`slai_purge_expired_auth()`, which checks which auth tables exist);
 * - organizations past their deletion grace period are hard-deleted.
 *
 * `audit_events` and `usage_ledger` are never touched: they are append-only
 * (trigger-enforced) and kept at least a year (TR-30b).
 */
import { agentActions, agentRuns, audit, contracts, invitations, orgExports, ticketComments } from "@slai/db";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";
import { deleteOrgIfDue } from "./offboarding.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM = { type: "system" as const, id: null, name: "retention" };

export interface RetentionConfig {
  /** Ticket comment bodies and agent outputs older than this are purged. */
  contentDays: number;
  /** Archived contracts (row and file) are hard-deleted this long after archiving. */
  archivedContractDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = { contentDays: 400, archivedContractDays: 30 };

export interface OrgPurge {
  comments: number;
  agentOutputs: number;
  actionBodies: number;
  invitations: number;
  contracts: number;
  exports: number;
}

/** One org's retention pass. Content purges commit together with their audit record. */
export async function purgeOrg(deps: WorkerDeps, orgId: string): Promise<OrgPurge> {
  const now = deps.clock.now();
  const cfg = deps.config.retention;
  const contentCutoff = new Date(now.getTime() - cfg.contentDays * DAY_MS);
  const contractCutoff = new Date(now.getTime() - cfg.archivedContractDays * DAY_MS);

  const counts = await deps.orgDb.withOrg(orgId, async (tx) => {
    const comments = await tx
      .update(ticketComments)
      .set({ body: "", redactedAt: now })
      .where(and(lt(ticketComments.at, contentCutoff), isNull(ticketComments.redactedAt)))
      .returning({ id: ticketComments.id });
    const outputs = await tx
      .update(agentRuns)
      .set({ output: null, error: null })
      .where(
        and(
          inArray(agentRuns.kind, ["triage", "draft_reply"]),
          lt(agentRuns.createdAt, contentCutoff),
          or(isNotNull(agentRuns.output), isNotNull(agentRuns.error)),
        ),
      )
      .returning({ id: agentRuns.id });
    const actions = await tx
      .update(agentActions)
      .set({ body: null, payload: {} })
      .where(
        and(
          inArray(agentActions.status, ["sent", "rejected", "failed", "blocked"]),
          lt(agentActions.createdAt, contentCutoff),
          or(isNotNull(agentActions.body), ne(agentActions.payload, sql`'{}'::jsonb`)),
        ),
      )
      .returning({ id: agentActions.id });
    const invites = await tx
      .delete(invitations)
      .where(and(isNull(invitations.acceptedAt), lt(invitations.expiresAt, now)))
      .returning({ id: invitations.id });
    const c = {
      comments: comments.length,
      agentOutputs: outputs.length,
      actionBodies: actions.length,
      invitations: invites.length,
    };
    if (c.comments || c.agentOutputs || c.actionBodies || c.invitations) {
      await audit(tx, {
        orgId,
        actor: SYSTEM,
        action: "retention.purged",
        target: { type: "organization", id: orgId },
        metadata: { ...c, contentDays: cfg.contentDays, cutoff: contentCutoff.toISOString() },
      });
    }
    return c;
  });

  // Files first, then rows: a crash in between leaves a row whose file is gone, which the next run finishes.
  const oldContracts = await deps.orgDb.withOrg(orgId, (tx) =>
    tx
      .select({ id: contracts.id, key: contracts.storageKey, filename: contracts.filename })
      .from(contracts)
      .where(
        and(
          eq(contracts.status, "archived"),
          sql`coalesce(${contracts.archivedAt}, ${contracts.updatedAt}) < ${contractCutoff.toISOString()}::timestamptz`,
        ),
      ),
  );
  for (const k of oldContracts) {
    await deps.storage.delete(k.key);
    await deps.orgDb.withOrg(orgId, async (tx) => {
      await tx.delete(contracts).where(eq(contracts.id, k.id));
      await audit(tx, {
        orgId,
        actor: SYSTEM,
        action: "contract.purged",
        target: { type: "contract", id: k.id },
        metadata: { archivedContractDays: cfg.archivedContractDays },
      });
    });
  }

  const expired = await deps.orgDb.withOrg(orgId, (tx) =>
    tx.select({ id: orgExports.id, key: orgExports.storageKey }).from(orgExports).where(lt(orgExports.expiresAt, now)),
  );
  for (const e of expired) {
    if (e.key) await deps.storage.delete(e.key);
    await deps.orgDb.withOrg(orgId, (tx) => tx.delete(orgExports).where(eq(orgExports.id, e.id)));
  }

  return { ...counts, contracts: oldContracts.length, exports: expired.length };
}

export interface RetentionRun {
  orgs: number;
  purged: Record<string, OrgPurge>;
  auth: { sessions: number; verifications: number; rateLimitBuckets: number };
  deletedOrgs: string[];
  failures: number;
}

/** The whole retention pass, across orgs. One org failing does not stop the others. */
export async function runRetention(deps: WorkerDeps): Promise<RetentionRun> {
  const orgRows = await deps.systemDb.db.execute<{ id: string; due: boolean }>(sql`
    select id::text as id,
           (deletion_scheduled_for is not null and deletion_scheduled_for <= ${deps.clock.now().toISOString()}::timestamptz) as due
    from organizations`);
  const run: RetentionRun = {
    orgs: orgRows.length,
    purged: {},
    auth: { sessions: 0, verifications: 0, rateLimitBuckets: 0 },
    deletedOrgs: [],
    failures: 0,
  };
  for (const o of orgRows) {
    try {
      if (o.due && (await deleteOrgIfDue(deps, o.id))) {
        run.deletedOrgs.push(o.id);
        continue;
      }
      const p = await purgeOrg(deps, o.id);
      if (Object.values(p).some((n) => n > 0)) run.purged[o.id] = p;
    } catch (e) {
      run.failures++;
      deps.logger.error({ orgId: o.id, err: errorMessage(e) }, "retention failed for org");
    }
  }
  const [a] = await deps.systemDb.db.execute<{ r: RetentionRun["auth"] }>(sql`select slai_purge_expired_auth() as r`);
  if (a) run.auth = a.r;
  deps.logger.info(
    {
      orgs: run.orgs,
      purgedOrgs: Object.keys(run.purged).length,
      deletedOrgs: run.deletedOrgs.length,
      auth: run.auth,
      failures: run.failures,
    },
    "retention run",
  );
  return run;
}
