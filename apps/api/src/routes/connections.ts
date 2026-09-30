import { randomBytes } from "node:crypto";
import { ConnectorError, type FieldMapping, mapPriority, mapStatus } from "@slai/connectors";
import { AAD, audit, connections, decrypt, decryptJson, encrypt, encryptJson, type Tx, tickets } from "@slai/db";
import {
  API_BASE,
  type Connection,
  type ConnectionMapping,
  type ConnectorInfo,
  createConnectionBody,
  type FieldMappingTable,
  setWebhookSecretBody,
  updateMappingBody,
  type WebhookSecretReveal,
} from "@slai/shared";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type AnyConnector, type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { ApiError, badRequest, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { oauthApp } from "../oauth.js";
import { body, idParam } from "../validate.js";
import { addKnowledgeSource } from "./knowledge.js";

type ConnectionRow = typeof connections.$inferSelect;

/** Whether slai generates the webhook secret (pasted into the help desk) or the help desk does. */
const secretSource = (def: AnyConnector | null) => def?.webhookSetup?.secret ?? "slai";

/**
 * Inserts a connection with encrypted credentials (and, when slai owns the
 * webhook secret, a fresh one), audits it and enqueues the first full sync.
 * Shared by the credential form and the OAuth callback.
 */
export async function insertConnection(
  deps: AppDeps,
  tx: Tx,
  c: Ctx,
  input: {
    orgId: string;
    userId: string;
    def: AnyConnector;
    name: string;
    credentials: unknown;
    config: Record<string, unknown>;
    via: "credentials" | "oauth";
  },
): Promise<ConnectionRow> {
  const id = crypto.randomUUID();
  const { def } = input;
  const ownSecret = def.supportsWebhooks && secretSource(def) === "slai";
  const [row] = await tx
    .insert(connections)
    .values({
      id,
      orgId: input.orgId,
      provider: def.provider,
      name: input.name,
      status: "active",
      credentials: encryptJson(input.credentials, { keyring: deps.keyring, aad: AAD.connectionCredentials(id) }),
      // Providers that sign with their own secret get it pasted in later (PUT webhook-secret).
      webhookSecret: ownSecret
        ? encrypt(randomBytes(32).toString("base64url"), {
            keyring: deps.keyring,
            aad: AAD.connectionWebhookSecret(id),
          })
        : null,
      config: input.config,
      // Overrides only; the worker layers them over the connector's default mapping.
      mapping: { status: {}, priority: {} },
      createdBy: input.userId,
    })
    .returning();
  await audit(tx, {
    ...auditBase(c),
    orgId: input.orgId,
    action: "connection.created",
    target: { type: "connection", id },
    metadata: { provider: def.provider, name: input.name, via: input.via },
  });
  await deps.jobs.send(tx, "sync-connection", { orgId: input.orgId, connectionId: id, full: true });
  if (def.supportsKnowledge) await addKnowledgeSource(tx, c, deps, { connectionId: id, name: input.name });
  return row!;
}

/** Stored overrides minus entries equal to the defaults (older rows stored the whole default mapping). */
function overridesOf(def: AnyConnector, stored: ConnectionRow["mapping"]): FieldMappingTable {
  const d = def.defaultMapping as FieldMappingTable;
  const status: FieldMappingTable["status"] = {};
  const priority: FieldMappingTable["priority"] = {};
  for (const [raw, v] of Object.entries(stored?.status ?? {})) {
    if (d.status[raw] !== v) status[raw] = v as FieldMappingTable["status"][string];
  }
  for (const [raw, v] of Object.entries(stored?.priority ?? {})) {
    if (!Object.hasOwn(d.priority, raw) || d.priority[raw] !== v) {
      priority[raw] = v as FieldMappingTable["priority"][string];
    }
  }
  return { status, priority };
}

function effectiveOf(def: AnyConnector, o: FieldMappingTable): FieldMapping {
  return {
    status: { ...def.defaultMapping.status, ...o.status },
    priority: { ...def.defaultMapping.priority, ...o.priority },
  };
}

const isMapped = (m: FieldMapping, i: { field: "status" | "priority"; raw: string }) =>
  i.field === "status" ? mapStatus(m, i.raw).known : mapPriority(m, i.raw).known;

export function connectionRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const webhookUrl = (row: Pick<ConnectionRow, "id" | "provider">) =>
    deps.connectors.get(row.provider)?.supportsWebhooks
      ? `${deps.env.API_URL.replace(/\/$/, "")}${API_BASE}/webhooks/${row.id}`
      : null;

  // Never carries the webhook secret or credentials: those only leave through the audited reveal.
  const toDto = (row: ConnectionRow, ticketCount: number): Connection => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    mappingIssues: row.mappingIssues,
    webhookUrl: webhookUrl(row),
    ticketCount,
    createdAt: row.createdAt.toISOString(),
  });

  // Qualified by hand: drizzle renders a lone column unqualified, and inside this
  // subquery an unqualified "id" binds to tickets.id (so the count was always 0).
  const ticketCounts = () =>
    sql<number>`(select count(*)::int from ${tickets} as t where t.connection_id = ${connections}.id)`;

  const load = async (tx: Tx, id: string) => {
    const [row] = await tx
      .select({ row: connections, n: ticketCounts() })
      .from(connections)
      .where(eq(connections.id, id));
    if (!row) throw notFound("Connection");
    return row;
  };

  const connectorOf = (row: ConnectionRow) => {
    const def = deps.connectors.get(row.provider);
    if (!def) throw badRequest(`Provider "${row.provider}" is not available.`);
    return def;
  };

  app.get("/connectors", (c) => {
    const items: ConnectorInfo[] = deps.connectors.list().map((d) => ({
      provider: d.provider,
      displayName: d.displayName,
      authKind: d.authKind,
      fields: d.credentialFields,
      supportsWebhooks: d.supportsWebhooks,
      write: d.write,
      docsUrl: d.docsUrl,
      ...(d.oauth
        ? {
            oauth: {
              configured: oauthApp(deps.env, d.provider) !== null,
              params: (d.oauth.params ?? []).map(({ key, label, placeholder, help, options }) => ({
                key,
                label,
                ...(placeholder ? { placeholder } : {}),
                ...(help ? { help } : {}),
                ...(options ? { options: [...options] } : {}),
              })),
            },
          }
        : {}),
      supportsKnowledge: d.supportsKnowledge ?? false,
    }));
    return c.json(items);
  });

  app.get("/connections", async (c) => {
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx.select({ row: connections, n: ticketCounts() }).from(connections).orderBy(desc(connections.id)),
    );
    return c.json({ items: rows.map((r) => toDto(r.row, r.n)), nextCursor: null });
  });

  app.post("/connections", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, createConnectionBody);
    const def = deps.connectors.get(input.provider);
    if (!def) throw badRequest(`Unknown provider "${input.provider}".`);
    const creds = def.credentialsSchema.safeParse(input.credentials);
    // Field names only: never echo credential values back.
    if (!creds.success)
      throw new ApiError(
        400,
        "invalid_credentials",
        "Credentials are invalid.",
        creds.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    const row = await deps.orgDb.withOrg(a.orgId, (tx) =>
      insertConnection(deps, tx, c, {
        orgId: a.orgId,
        userId: a.user.id,
        def,
        name: input.name,
        credentials: creds.data,
        config: input.config,
        via: "credentials",
      }),
    );
    return c.json(toDto(row, 0), 201);
  });

  app.get("/connections/:id", async (c) => {
    const id = idParam(c, "id", "Connection");
    const r = await deps.orgDb.withOrg(auth(c).orgId, (tx) => load(tx, id));
    return c.json(toDto(r.row, r.n));
  });

  app.delete("/connections/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Connection");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [row] = await tx
        .delete(connections)
        .where(eq(connections.id, id))
        .returning({ provider: connections.provider, name: connections.name });
      if (!row) throw notFound("Connection");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "connection.deleted",
        target: { type: "connection", id },
        metadata: row,
      });
    });
    return c.body(null, 204);
  });

  app.post("/connections/:id/test", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Connection");
    const { row } = await deps.orgDb.withOrg(a.orgId, (tx) => load(tx, id));
    const def = connectorOf(row);
    const client = def.create({
      credentials: decryptJson(row.credentials, { keyring: deps.keyring, aad: AAD.connectionCredentials(id) }),
      config: row.config,
      mapping: effectiveOf(def, overridesOf(def, row.mapping)),
      fetch: deps.fetch,
      onCredentialsRefreshed: (next: unknown) =>
        deps.orgDb.withOrg(a.orgId, async (tx) => {
          await tx
            .update(connections)
            .set({ credentials: encryptJson(next, { keyring: deps.keyring, aad: AAD.connectionCredentials(id) }) })
            .where(eq(connections.id, id));
        }),
    });
    let result:
      | { ok: true; accountName: string }
      | { ok: false; accountName: null; error: { kind: string; message: string } };
    try {
      const r = await client.testConnection();
      result = { ok: true, accountName: r.accountName };
    } catch (e) {
      const kind = e instanceof ConnectorError ? e.kind : "upstream";
      const message = e instanceof ConnectorError ? e.message : "The help desk could not be reached.";
      result = { ok: false, accountName: null, error: { kind, message } };
    }
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await tx
        .update(connections)
        .set(result.ok ? { status: "active", lastError: null } : { status: "error", lastError: result.error.message })
        .where(eq(connections.id, id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "connection.tested",
        target: { type: "connection", id },
        metadata: { ok: result.ok },
      });
    });
    return c.json(result);
  });

  app.post("/connections/:id/sync", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Connection");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await load(tx, id);
      await deps.jobs.send(tx, "sync-connection", { orgId: a.orgId, connectionId: id, full: false });
    });
    return c.json({ queued: true }, 202);
  });

  // ---------------------------------------------------------------- status/priority mapping (T-25, PR-8)

  const mappingDto = async (tx: Tx, row: ConnectionRow): Promise<ConnectionMapping> => {
    const def = connectorOf(row);
    const overrides = overridesOf(def, row.mapping);
    const effective = effectiveOf(def, overrides);
    const distinct = async (col: typeof tickets.rawStatus | typeof tickets.rawPriority) =>
      (
        await tx
          .selectDistinct({ v: col })
          .from(tickets)
          .where(and(eq(tickets.connectionId, row.id), isNotNull(col)))
          .orderBy(col)
          .limit(200)
      )
        .map((r) => r.v)
        .filter((v): v is string => typeof v === "string" && v !== "")
        .sort((a, b) => a.localeCompare(b));
    return {
      defaults: def.defaultMapping as FieldMappingTable,
      overrides,
      unmapped: row.mappingIssues.filter((i) => !isMapped(effective, i)),
      observed: { status: await distinct(tickets.rawStatus), priority: await distinct(tickets.rawPriority) },
    };
  };

  app.get("/connections/:id/mapping", async (c) => {
    const id = idParam(c, "id", "Connection");
    const out = await deps.orgDb.withOrg(auth(c).orgId, async (tx) => mappingDto(tx, (await load(tx, id)).row));
    return c.json(out);
  });

  app.put("/connections/:id/mapping", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Connection");
    const input = await body(c, updateMappingBody);
    const out = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { row } = await load(tx, id);
      const def = connectorOf(row);
      const before = overridesOf(def, row.mapping);
      const overrides = overridesOf(def, input);
      const effective = effectiveOf(def, overrides);
      // Values the new mapping covers are no longer "unmapped"; sync re-adds any that still are.
      const mappingIssues = row.mappingIssues.filter((i) => !isMapped(effective, i));
      const [updated] = await tx
        .update(connections)
        .set({ mapping: overrides, mappingIssues })
        .where(eq(connections.id, id))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "connection.mapping_updated",
        target: { type: "connection", id },
        metadata: {
          reset: Object.keys(overrides.status).length + Object.keys(overrides.priority).length === 0,
          before,
          after: overrides,
        },
      });
      // Re-ingest so stored events are re-mapped and every affected clock recomputes.
      await deps.jobs.send(tx, "remap-connection", { orgId: a.orgId, connectionId: id });
      return mappingDto(tx, updated!);
    });
    return c.json(out);
  });

  // ---------------------------------------------------------------- webhook secret (T-57)

  app.post("/connections/:id/webhook-secret/reveal", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Connection");
    const out = await deps.orgDb.withOrg(a.orgId, async (tx): Promise<WebhookSecretReveal> => {
      const { row } = await load(tx, id);
      const def = connectorOf(row);
      const url = webhookUrl(row);
      if (!url) throw badRequest(`${def.displayName} has no webhooks; slai polls it.`);
      const source = secretSource(def);
      const secret =
        source === "slai" && row.webhookSecret
          ? decrypt(row.webhookSecret, { keyring: deps.keyring, aad: AAD.connectionWebhookSecret(id) })
          : null;
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "connection.webhook_secret_revealed",
        target: { type: "connection", id },
        metadata: { provider: row.provider, secretSource: source },
      });
      return {
        webhookUrl: url,
        secretSource: source,
        secret,
        configured: row.webhookSecret !== null,
        steps: [...(def.webhookSetup?.steps ?? [])],
      };
    });
    return c.json(out);
  });

  app.put("/connections/:id/webhook-secret", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Connection");
    const input = await body(c, setWebhookSecretBody);
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { row } = await load(tx, id);
      const def = connectorOf(row);
      if (!def.supportsWebhooks || secretSource(def) !== "provider") {
        throw badRequest("slai generates this connection's webhook secret; reveal it instead.");
      }
      await tx
        .update(connections)
        .set({
          webhookSecret: encrypt(input.secret, { keyring: deps.keyring, aad: AAD.connectionWebhookSecret(id) }),
        })
        .where(eq(connections.id, id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "connection.webhook_secret_set",
        target: { type: "connection", id },
        metadata: { provider: row.provider },
      });
    });
    return c.body(null, 204);
  });

  return app;
}

/** Public webhook intake. Authenticated by the connector's signature check, not by session. */
export function webhookRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.post("/:connectionId", async (c) => {
    const id = idParam(c, "connectionId", "Webhook");
    if (!deps.rateLimits.webhook.take(id)) throw new ApiError(429, "rate_limited", "Too many requests.");
    // Routing only: the system role can read a connection's org, not its secrets.
    const [route] = await deps.systemDb.db
      .select({ orgId: connections.orgId, provider: connections.provider, status: connections.status })
      .from(connections)
      .where(eq(connections.id, id));
    const def = route ? deps.connectors.get(route.provider) : null;
    if (!route || !def?.supportsWebhooks) throw notFound("Webhook");
    const rawBody = await c.req.text();

    const [row] = await deps.orgDb.withOrg(route.orgId, (tx) =>
      tx.select().from(connections).where(eq(connections.id, id)),
    );
    if (!row) throw notFound("Webhook");
    const client = def.create({
      credentials: decryptJson(row.credentials, { keyring: deps.keyring, aad: AAD.connectionCredentials(id) }),
      config: row.config,
      mapping: effectiveOf(def, overridesOf(def, row.mapping)),
      fetch: deps.fetch,
    });
    const secret = row.webhookSecret
      ? decrypt(row.webhookSecret, { keyring: deps.keyring, aad: AAD.connectionWebhookSecret(id) })
      : null;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const url = `${deps.env.API_URL.replace(/\/$/, "")}${API_BASE}/webhooks/${id}`;
    const result = await client.handleWebhook({ headers, rawBody, url }, secret);
    if (!result.ok) {
      if (result.reason === "bad_signature") {
        deps.logger.warn(
          { requestId: c.get("requestId"), connectionId: id, ip: c.get("ip") },
          "webhook signature rejected",
        );
        throw new ApiError(401, "bad_signature", "Invalid webhook signature.");
      }
      if (result.reason === "unsupported") return c.json({ ok: true, ignored: true }, 202);
      throw badRequest("Malformed webhook payload.");
    }
    if (route.status === "paused") return c.json({ ok: true, ignored: true }, 202);
    const ids = [...new Set(result.ticketSourceIds)].slice(0, 1000);
    if (ids.length > 0) {
      await deps.orgDb.withOrg(route.orgId, (tx) =>
        deps.jobs.send(tx, "process-webhook", { orgId: route.orgId, connectionId: id, ticketSourceIds: ids }),
      );
    }
    return c.json({ ok: true, tickets: ids.length }, 202);
  });

  return app;
}
