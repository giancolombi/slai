import { createHmac, randomUUID } from "node:crypto";
import type { ConnectorDefinition } from "@slai/connectors";
import { connections, ENTERPRISE_POLICY, slaOutcomes, ticketEvents, tickets } from "@slai/db";
import { z } from "zod";
import type { TestCtx } from "./harness.js";

export const policyInput = () => structuredClone(ENTERPRISE_POLICY);

export interface FakeCalls {
  created: { credentials: unknown; config: unknown }[];
}

/** A connector double: HMAC-SHA256 webhook signatures over the raw body with the connection's secret. */
export function fakeConnector(
  calls: FakeCalls = { created: [] },
): ConnectorDefinition<{ subdomain: string; token: string }> {
  return {
    provider: "zendesk",
    displayName: "Zendesk (fake)",
    authKind: "api_token",
    credentialsSchema: z.object({ subdomain: z.string().regex(/^[a-z0-9-]+$/), token: z.string().min(8) }),
    credentialFields: [
      { key: "subdomain", label: "Subdomain", secret: false },
      { key: "token", label: "API token", secret: true },
    ],
    supportsWebhooks: true,
    write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
    defaultMapping: { status: { open: "open" }, priority: { high: "high" } },
    docsUrl: "https://example.com/docs",
    create(ctx) {
      calls.created.push({ credentials: ctx.credentials, config: ctx.config });
      return {
        async testConnection() {
          return { accountName: `Acct ${ctx.credentials.subdomain}`, accountId: "1" };
        },
        async handleWebhook(req, secret) {
          const expected = createHmac("sha256", secret ?? "")
            .update(req.rawBody)
            .digest("hex");
          if (!secret || req.headers["x-signature"] !== expected) return { ok: false, reason: "bad_signature" };
          try {
            const body = JSON.parse(req.rawBody) as { ticketIds: string[] };
            return { ok: true, ticketSourceIds: body.ticketIds };
          } catch {
            return { ok: false, reason: "malformed" };
          }
        },
        listUpdatedTickets: async () => ({ items: [], nextCursor: null }),
        getTicketWithHistory: async () => {
          throw new Error("not used");
        },
        postInternalNote: async () => ({ commentSourceId: null }),
        postPublicReply: async () => ({ commentSourceId: null }),
        updateTicket: async () => {},
      };
    },
  };
}

export const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

/** Inserts (as the DB owner) a connection-less-safe ticket with history and outcomes. */
export async function seedTicket(
  ctx: TestCtx,
  orgId: string,
  opts: {
    connectionId?: string;
    policyId?: string | null;
    customerAccountId?: string | null;
    createdAt?: Date;
    subject?: string;
    risk?: "ok" | "warning" | "at_risk" | "breached";
    outcomes?: {
      metric: "first_response" | "resolution";
      state: "achieved" | "breached";
      priority?: "urgent" | "high" | "normal";
    }[];
  } = {},
) {
  let connectionId = opts.connectionId;
  if (!connectionId) {
    const [conn] = await ctx.owner.db
      .insert(connections)
      .values({ orgId, provider: "demo", name: "Demo", credentials: "v1.k1.a.b.c" })
      .returning();
    connectionId = conn!.id;
  }
  const created = opts.createdAt ?? new Date(Date.now() - 60 * 60 * 1000);
  const [t] = await ctx.owner.db
    .insert(tickets)
    .values({
      orgId,
      connectionId,
      externalId: randomUUID(),
      displayKey: `#${Math.floor(Math.random() * 99999)}`,
      subject: opts.subject ?? "Cannot log in",
      requesterEmail: "pat@globex.com",
      status: "open",
      priority: "urgent",
      policyId: opts.policyId ?? null,
      customerAccountId: opts.customerAccountId ?? null,
      risk: opts.risk ?? "ok",
      nextDueAt: new Date(created.getTime() + 60 * 60 * 1000),
      createdAtSource: created,
      updatedAtSource: created,
    })
    .returning();
  await ctx.owner.db.insert(ticketEvents).values([
    {
      orgId,
      ticketId: t!.id,
      idempotencyKey: "c",
      type: "created",
      at: created,
      payload: { priority: "urgent", status: "new" },
    },
    {
      orgId,
      ticketId: t!.id,
      idempotencyKey: "s",
      type: "status_changed",
      at: new Date(created.getTime() + 60_000),
      payload: { status: "open", rawStatus: "open" },
    },
  ]);
  const now = Date.now();
  for (const [i, o] of (opts.outcomes ?? []).entries()) {
    await ctx.owner.db.insert(slaOutcomes).values({
      orgId,
      ticketId: t!.id,
      policyId: opts.policyId ?? null,
      metric: o.metric,
      cycleIndex: i,
      priority: o.priority ?? "urgent",
      state: o.state,
      startedAt: new Date(now - 3 * 60 * 60 * 1000),
      stoppedAt: new Date(now - 60 * 1000),
      breachAt: o.state === "breached" ? new Date(now - 2 * 60 * 60 * 1000) : null,
      targetMs: 3_600_000,
      elapsedMs: o.state === "breached" ? 7_200_000 : 1_800_000,
    });
  }
  return { ticketId: t!.id, connectionId };
}
