import { randomBytes } from "node:crypto";
import { ConnectorError, type FieldMapping } from "@slai/connectors";
import { AAD, audit, connections, decrypt, decryptJson, encrypt, encryptJson, type Tx, tickets } from "@slai/db";
import { API_BASE, type Connection, type ConnectorInfo, createConnectionBody } from "@slai/shared";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { ApiError, badRequest, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

type ConnectionRow = typeof connections.$inferSelect;

export function connectionRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const webhookUrl = (row: Pick<ConnectionRow, "id" | "provider">) =>
    deps.connectors.get(row.provider)?.supportsWebhooks
      ? `${deps.env.API_URL.replace(/\/$/, "")}${API_BASE}/webhooks/${row.id}`
      : null;

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

  const ticketCounts = () =>
    sql<number>`(select count(*)::int from ${tickets} where ${tickets.connectionId} = ${connections.id})`;

  const load = async (tx: Tx, id: string) => {
    const [row] = await tx
      .select({ row: connections, n: ticketCounts() })
      .from(connections)
      .where(eq(connections.id, id));
    if (!row) throw notFound("Connection");
    return row;
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
    const id = crypto.randomUUID();
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [r] = await tx
        .insert(connections)
        .values({
          id,
          orgId: a.orgId,
          provider: def.provider,
          name: input.name,
          status: "active",
          credentials: encryptJson(creds.data, { keyring: deps.keyring, aad: AAD.connectionCredentials(id) }),
          webhookSecret: encrypt(randomBytes(32).toString("base64url"), {
            keyring: deps.keyring,
            aad: AAD.connectionWebhookSecret(id),
          }),
          config: input.config,
          mapping: def.defaultMapping,
          createdBy: a.user.id,
        })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "connection.created",
        target: { type: "connection", id },
        metadata: { provider: def.provider, name: input.name },
      });
      await deps.jobs.send(tx, "sync-connection", { orgId: a.orgId, connectionId: id, full: true });
      return r!;
    });
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
    const def = deps.connectors.get(row.provider);
    if (!def) throw badRequest(`Provider "${row.provider}" is not available.`);
    const client = def.create({
      credentials: decryptJson(row.credentials, { keyring: deps.keyring, aad: AAD.connectionCredentials(id) }),
      config: row.config,
      mapping: (row.mapping as FieldMapping | null) ?? def.defaultMapping,
      fetch: deps.fetch,
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
      mapping: (row.mapping as FieldMapping | null) ?? def.defaultMapping,
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
