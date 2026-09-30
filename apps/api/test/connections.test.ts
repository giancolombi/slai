import { AAD, connections, decrypt } from "@slai/db";
import type { Connection } from "@slai/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type FakeCalls, fakeConnector, sign } from "./fixtures.js";
import { API_URL, fakeRegistry, setupApp, signup } from "./harness.js";

const calls: FakeCalls = { created: [] };
const ctx = setupApp({ connectors: fakeRegistry([fakeConnector(calls)]) });
let owner: Awaited<ReturnType<typeof signup>>;
let conn: Connection;
let secret: string;

beforeAll(async () => {
  owner = await signup(ctx);
  const res = await owner.client.post<Connection>("/connections", {
    provider: "zendesk",
    name: "Support",
    credentials: { subdomain: "acme", token: "zd-super-secret-token" },
    config: { brand: "main" },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  conn = res.body;
  const [row] = await ctx.owner.db.select().from(connections).where(eq(connections.id, conn.id));
  secret = decrypt(row!.webhookSecret!, { keyring: ctx.deps.keyring, aad: AAD.connectionWebhookSecret(conn.id) });
});

describe("connectors and connections", () => {
  it("lists connector definitions from the registry", async () => {
    const res = await owner.client.get("/connectors");
    expect(res.body).toEqual([
      expect.objectContaining({
        provider: "zendesk",
        authKind: "api_token",
        supportsWebhooks: true,
        fields: expect.any(Array),
      }),
    ]);
  });

  it("creates a connection with encrypted credentials and a webhook URL, never echoing secrets", async () => {
    expect(conn.webhookUrl).toBe(`${API_URL}/api/v1/webhooks/${conn.id}`);
    expect(JSON.stringify(conn)).not.toContain("zd-super-secret-token");
    const [row] = await ctx.owner.db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row!.credentials).toMatch(/^v1\.k1\./);
    expect(row!.credentials).not.toContain("zd-super-secret-token");
    const list = await owner.client.get("/connections");
    expect(JSON.stringify(list.body)).not.toMatch(/zd-super-secret-token|v1\.k1\./);
    const [job] = await ctx.owner.client`select name from pgboss.job where data->>'connectionId' = ${conn.id}`;
    expect(job?.name).toBe("sync-connection");
  });

  it("validates credentials with the connector's schema without echoing values", async () => {
    const res = await owner.client.post("/connections", {
      provider: "zendesk",
      name: "Bad",
      credentials: { subdomain: "Not Valid!", token: "leakme-please" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_credentials");
    expect(JSON.stringify(res.body)).not.toContain("leakme-please");
    expect((await owner.client.post("/connections", { provider: "nope", name: "x", credentials: {} })).status).toBe(
      400,
    );
  });

  it("tests a connection with decrypted credentials", async () => {
    const res = await owner.client.post(`/connections/${conn.id}/test`);
    expect(res.body).toEqual({ ok: true, accountName: "Acct acme" });
    expect(calls.created.at(-1)).toEqual({
      credentials: { subdomain: "acme", token: "zd-super-secret-token" },
      config: { brand: "main" },
    });
  });
});

describe("webhooks", () => {
  const deliver = (id: string, body: string, headers: Record<string, string> = {}) =>
    ctx.app.request(`/api/v1/webhooks/${id}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });

  it("rejects a bad signature with 401 and enqueues nothing", async () => {
    const body = JSON.stringify({ ticketIds: ["bad-sig-1"] });
    expect((await deliver(conn.id, body, { "x-signature": sign("wrong-secret", body) })).status).toBe(401);
    expect((await deliver(conn.id, body)).status).toBe(401);
    const jobs = await ctx.owner.client`select 1 from pgboss.job where data->'ticketSourceIds' ? 'bad-sig-1'`;
    expect(jobs).toHaveLength(0);
  });

  it("accepts a valid signature (no session or CSRF header needed) and enqueues process-webhook", async () => {
    const body = JSON.stringify({ ticketIds: ["T-1", "T-2", "T-1"] });
    const res = await deliver(conn.id, body, { "x-signature": sign(secret, body) });
    expect(res.status).toBe(202);
    const [job] = await ctx.owner.client`select name, data from pgboss.job where data->'ticketSourceIds' ? 'T-2'`;
    expect(job).toEqual({
      name: "process-webhook",
      data: { orgId: owner.orgId, connectionId: conn.id, ticketSourceIds: ["T-1", "T-2"] },
    });
  });

  it("404s unknown connections and non-uuid ids", async () => {
    expect((await deliver("00000000-0000-4000-8000-000000000000", "{}")).status).toBe(404);
    expect((await deliver("../../etc", "{}")).status).toBe(404);
  });

  it("rate-limits deliveries per connection", async () => {
    const res = await Promise.all(Array.from({ length: 320 }, () => deliver(conn.id, "{}")));
    expect(res.some((r) => r.status === 429)).toBe(true);
  });
});
