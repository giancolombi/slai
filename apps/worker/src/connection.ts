/**
 * Loading a connection and building its connector client. Credentials are
 * decrypted just in time, only in memory, and never logged.
 */
import { type ConnectorClient, ConnectorError, type FieldMapping, type MappingIssue } from "@slai/connectors";
import { AAD, audit, connections, decryptJson, encryptJson, type Tx } from "@slai/db";
import { eq } from "drizzle-orm";
import type { WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";

export type ConnectionRow = typeof connections.$inferSelect;

export async function loadConnection(tx: Tx, id: string): Promise<ConnectionRow | null> {
  const [row] = await tx.select().from(connections).where(eq(connections.id, id));
  return row ?? null;
}

export function connectorFor(deps: WorkerDeps, conn: ConnectionRow) {
  const def = deps.connectors.get(conn.provider);
  if (!def) throw new ConnectorError(`no connector for provider "${conn.provider}"`, "unsupported");
  return def;
}

/** The connector's default mapping with the connection's overrides on top. */
export function mappingFor(def: ReturnType<typeof connectorFor>, conn: ConnectionRow): FieldMapping {
  const override = conn.mapping as Partial<FieldMapping> | null;
  return {
    status: { ...def.defaultMapping.status, ...(override?.status ?? {}) },
    priority: { ...def.defaultMapping.priority, ...(override?.priority ?? {}) },
  };
}

export function clientFor(deps: WorkerDeps, conn: ConnectionRow): ConnectorClient {
  const def = connectorFor(deps, conn);
  const credentials = def.credentialsSchema.parse(
    decryptJson(conn.credentials, { keyring: deps.keyring, aad: AAD.connectionCredentials(conn.id) }),
  );
  // The demo help desk keeps its write store per connection and follows the worker's clock.
  const config =
    conn.provider === "demo"
      ? { ...conn.config, connectionId: conn.id, now: () => deps.clock.now() }
      : (conn.config ?? {});
  const mapping = mappingFor(def, conn);
  return def.create({
    credentials,
    config,
    mapping,
    fetch: deps.fetch,
    // A refreshed (possibly rotated) OAuth token is re-encrypted and stored for the next job.
    onCredentialsRefreshed: (next: unknown) =>
      deps.orgDb.withOrg(conn.orgId, async (tx) => {
        await tx
          .update(connections)
          .set({ credentials: encryptJson(next, { keyring: deps.keyring, aad: AAD.connectionCredentials(conn.id) }) })
          .where(eq(connections.id, conn.id));
      }),
  });
}

/** Marks the connection broken (bad credentials) so the UI asks the user to reconnect. */
export async function markConnectionError(deps: WorkerDeps, orgId: string, connectionId: string, err: unknown) {
  const message = errorMessage(err);
  deps.logger.warn({ orgId, connectionId, err: message }, "connection auth failed");
  await deps.orgDb.withOrg(orgId, async (tx) => {
    await tx.update(connections).set({ status: "error", lastError: message }).where(eq(connections.id, connectionId));
    await audit(tx, {
      orgId,
      actor: { type: "system", id: null, name: "slai" },
      action: "connection.error",
      target: { type: "connection", id: connectionId },
      metadata: { error: message },
    });
  });
}

/**
 * Runs `fn`; an auth failure marks the connection as errored (and ends the job
 * quietly, since retrying cannot help). Other errors propagate.
 */
export async function guardAuth<T>(
  deps: WorkerDeps,
  orgId: string,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === "auth") {
      await markConnectionError(deps, orgId, connectionId, e);
      return null;
    }
    throw e;
  }
}

const MAX_ISSUES = 50;

/** Adds unmapped raw values to the connection (deduplicated, bounded) for the UI. */
export async function recordMappingIssues(tx: Tx, connectionId: string, issues: MappingIssue[] | undefined) {
  if (!issues?.length) return;
  const [row] = await tx
    .select({ mappingIssues: connections.mappingIssues })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!row) return;
  const merged = mergeIssues(row.mappingIssues, issues);
  if (merged.length !== row.mappingIssues.length) {
    await tx.update(connections).set({ mappingIssues: merged }).where(eq(connections.id, connectionId));
  }
}

export function mergeIssues(a: MappingIssue[], b: MappingIssue[]): MappingIssue[] {
  const seen = new Set(a.map((i) => `${i.field}:${i.raw}`));
  const out = [...a];
  for (const i of b) {
    const k = `${i.field}:${i.raw}`;
    if (!seen.has(k) && out.length < MAX_ISSUES) {
      seen.add(k);
      out.push({ field: i.field, raw: i.raw });
    }
  }
  return out;
}
