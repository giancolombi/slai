/**
 * Org offboarding jobs (T-64): the export bundle and the grace-period hard delete.
 *
 * Export: a tar.gz with `manifest.json`, one `data/<table>.json` per org table,
 * and every contract file under `contracts/<id>/<filename>`. Secrets are left
 * out (connector credentials, webhook secrets, Slack webhook URLs, SSO configs,
 * invitation tokens). The bundle is built in memory; see TR-30c for the size
 * limit this implies.
 *
 * Delete: removes the org's stored files, then calls `slai_delete_org`, which
 * deletes the organization (every org table cascades) only if its grace period
 * has passed, so a cancelled or not-yet-due deletion is never carried out. The
 * audit trail and usage ledger are kept (no foreign key to organizations).
 */
import { createHash } from "node:crypto";
import {
  agentActions,
  agentRuns,
  audit,
  auditEvents,
  autonomyRules,
  connections,
  contracts,
  customerAccounts,
  exportStorageKey,
  invitations,
  memberships,
  notificationChannels,
  organizations,
  orgExports,
  replays,
  slaOutcomes,
  slaPolicies,
  ssoProviders,
  type Tx,
  ticketComments,
  ticketEvents,
  tickets,
  usageLedger,
  users,
} from "@slai/db";
import { eq, sql } from "drizzle-orm";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";
import { type TarEntry, tarGz } from "./tar.js";

export const EXPORT_FORMAT = "slai-export/1";
const SYSTEM = { type: "system" as const, id: null, name: "offboarding" };

type Table = [name: string, read: (tx: Tx) => Promise<unknown[]>];

/** Every table in the bundle, with secrets projected away. RLS confines each read to the org. */
const TABLES: Table[] = [
  ["organization", (tx) => tx.select().from(organizations)],
  [
    "members",
    (tx) =>
      tx
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)),
  ],
  [
    "invitations",
    (tx) =>
      tx
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations),
  ],
  [
    "connections",
    (tx) =>
      tx
        .select({
          id: connections.id,
          provider: connections.provider,
          name: connections.name,
          status: connections.status,
          config: connections.config,
          mapping: connections.mapping,
          lastSyncAt: connections.lastSyncAt,
          createdAt: connections.createdAt,
        })
        .from(connections),
  ],
  [
    "sso_providers",
    (tx) =>
      tx
        .select({
          id: ssoProviders.id,
          providerId: ssoProviders.providerId,
          name: ssoProviders.name,
          issuer: ssoProviders.issuer,
          domain: ssoProviders.domain,
          domainVerified: ssoProviders.domainVerified,
          createdAt: ssoProviders.createdAt,
        })
        .from(ssoProviders),
  ],
  ["customer_accounts", (tx) => tx.select().from(customerAccounts)],
  ["contracts", (tx) => tx.select().from(contracts)],
  ["sla_policies", (tx) => tx.select().from(slaPolicies)],
  ["tickets", (tx) => tx.select().from(tickets)],
  ["ticket_events", (tx) => tx.select().from(ticketEvents)],
  ["ticket_comments", (tx) => tx.select().from(ticketComments)],
  ["sla_outcomes", (tx) => tx.select().from(slaOutcomes)],
  ["agent_runs", (tx) => tx.select().from(agentRuns)],
  [
    "agent_actions",
    (tx) =>
      tx
        .select()
        .from(agentActions)
        .then((rows) => rows.map(({ sendAttemptId: _s, ...r }) => r)),
  ],
  ["autonomy_rules", (tx) => tx.select().from(autonomyRules)],
  [
    "notification_channels",
    (tx) =>
      tx
        .select()
        .from(notificationChannels)
        .then((rows) =>
          rows.map((r) => (r.kind === "slack_webhook" ? { ...r, target: "[slack webhook, not exported]" } : r)),
        ),
  ],
  ["replays", (tx) => tx.select().from(replays)],
  ["usage_ledger", (tx) => tx.select().from(usageLedger)],
  ["audit_events", (tx) => tx.select().from(auditEvents)],
];

const safeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-40) || "file";

export async function exportOrg(deps: WorkerDeps, p: { orgId: string; exportId: string }): Promise<void> {
  const { orgId, exportId } = p;
  const started = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [row] = await tx.select().from(orgExports).where(eq(orgExports.id, exportId)).for("update");
    if (!row || row.status !== "queued") return false;
    await tx.update(orgExports).set({ status: "running" }).where(eq(orgExports.id, exportId));
    return true;
  });
  if (!started) return;
  try {
    const now = deps.clock.now();
    const data = await deps.orgDb.withOrg(orgId, async (tx) => {
      const out: Record<string, unknown[]> = {};
      for (const [name, read] of TABLES) out[name] = await read(tx);
      return out;
    });
    const entries: TarEntry[] = [];
    const files: { contractId: string; path: string; sha256: string | null; missing?: true }[] = [];
    for (const c of data.contracts as (typeof contracts.$inferSelect)[]) {
      const path = `contracts/${c.id}/${safeName(c.filename)}`;
      try {
        const bytes = await deps.storage.get(c.storageKey);
        entries.push({ path, data: bytes });
        files.push({ contractId: c.id, path, sha256: createHash("sha256").update(bytes).digest("hex") });
      } catch {
        files.push({ contractId: c.id, path, sha256: null, missing: true });
      }
    }
    const manifest = {
      format: EXPORT_FORMAT,
      orgId,
      exportId,
      createdAt: now.toISOString(),
      tables: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      files,
      excluded: [
        "connector credentials and webhook secrets",
        "Slack webhook URLs",
        "SSO client secrets and SAML keys",
        "invitation tokens, password hashes, MFA secrets, sessions",
      ],
    };
    const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
    const bundle = tarGz(
      [
        { path: "manifest.json", data: json(manifest) },
        ...Object.entries(data).map(([name, rows]) => ({ path: `data/${name}.json`, data: json(rows) })),
        ...entries,
      ],
      now,
    );
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    const key = exportStorageKey(orgId, exportId);
    await deps.storage.put(key, bundle, { contentType: "application/gzip", sha256 });
    await deps.orgDb.withOrg(orgId, async (tx) => {
      await tx
        .update(orgExports)
        .set({ status: "succeeded", storageKey: key, sizeBytes: bundle.byteLength, sha256, finishedAt: now })
        .where(eq(orgExports.id, exportId));
      await audit(tx, {
        orgId,
        actor: SYSTEM,
        action: "org.export.completed",
        target: { type: "org_export", id: exportId },
        metadata: { sizeBytes: bundle.byteLength, sha256, tables: manifest.tables, files: files.length },
      });
    });
  } catch (e) {
    const message = errorMessage(e);
    deps.logger.error({ orgId, exportId, err: message }, "org export failed");
    await deps.orgDb.withOrg(orgId, (tx) =>
      tx
        .update(orgExports)
        .set({ status: "failed", error: "The export failed. Try again, or contact support.", finishedAt: new Date() })
        .where(eq(orgExports.id, exportId)),
    );
  }
}

/**
 * Hard-deletes `orgId` if its deletion is scheduled and due. Returns whether it
 * was deleted. Safe to call at any time: a cancelled or future deletion is a no-op.
 */
export async function deleteOrgIfDue(deps: WorkerDeps, orgId: string): Promise<boolean> {
  const now = deps.clock.now();
  const plan = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [org] = await tx.select().from(organizations);
    if (!org?.deletionScheduledFor || org.deletionScheduledFor > now) return null;
    // The database clock decides too (slai_delete_org uses it): never delete files for an org it would keep.
    const [db] = await tx.execute<{ due: boolean }>(
      sql`select deletion_scheduled_for <= now() as due from organizations where id = ${orgId}::uuid`,
    );
    if (!db?.due) return null;
    const keys = [
      ...(await tx.select({ k: contracts.storageKey }).from(contracts)).map((r) => r.k),
      ...(await tx.select({ k: orgExports.storageKey }).from(orgExports)).flatMap((r) => (r.k ? [r.k] : [])),
    ];
    return { org, keys };
  });
  if (!plan) return false;
  for (const k of plan.keys) await deps.storage.delete(k);
  const [r] = await deps.systemDb.db.execute<{ deleted: boolean }>(
    sql`select slai_delete_org(${orgId}::uuid) as deleted`,
  );
  if (!r?.deleted) return false;
  // The org is gone, so this is written by the system role; audit_events keeps the org id.
  await audit(deps.systemDb.db, {
    orgId,
    actor: SYSTEM,
    action: "org.deleted",
    target: { type: "organization", id: orgId },
    metadata: {
      name: plan.org.name,
      scheduledFor: plan.org.deletionScheduledFor!.toISOString(),
      requestedBy: plan.org.deletionRequestedBy,
      filesDeleted: plan.keys.length,
    },
  });
  deps.logger.info({ orgId, files: plan.keys.length }, "organization deleted");
  return true;
}
