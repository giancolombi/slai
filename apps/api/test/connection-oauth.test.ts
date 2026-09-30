import { createHash } from "node:crypto";
import { getConnector } from "@slai/connectors";
import { AAD, auditEvents, connections, decrypt, decryptJson } from "@slai/db";
import type { Connection, ConnectorInfo, WebhookSecretReveal } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeConnector } from "./fixtures.js";
import { APP_URL, addMember, Client, fakeRegistry, setupApp, signup } from "./harness.js";

/**
 * A local fake of the providers' token endpoints (the injected fetch): records
 * each form-encoded request and answers from `tokenReplies`.
 */
const tokenRequests: { url: string; form: Record<string, string> }[] = [];
const tokenReplies: { status: number; json: unknown }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
  tokenRequests.push({ url, form });
  const reply = tokenReplies.shift() ?? { status: 500, json: { error: "unexpected" } };
  return new Response(JSON.stringify(reply.json), { status: reply.status });
}) as typeof fetch;

const hubspot = getConnector("hubspot")!;
const salesforce = getConnector("salesforce")!;
const helpScout = getConnector("help_scout")!;
const ctx = setupApp(
  { connectors: fakeRegistry([fakeConnector(), hubspot, salesforce, helpScout]), fetch: fakeFetch },
  {
    OAUTH_HUBSPOT_CLIENT_ID: "hs-client-id",
    OAUTH_HUBSPOT_CLIENT_SECRET: "hs-client-secret",
    OAUTH_SALESFORCE_CLIENT_ID: "sf-client-id",
    OAUTH_SALESFORCE_CLIENT_SECRET: "sf-client-secret",
  },
);

let owner: Awaited<ReturnType<typeof signup>>;
beforeAll(async () => {
  owner = await signup(ctx, "Oauth");
});

const start = (client: Client, provider: string, query = "") =>
  client.get(`/connections/oauth/${provider}/start${query ? `?${query}` : ""}`);
const callback = (client: Client, provider: string, query: Record<string, string>) =>
  client.get(`/connections/oauth/${provider}/callback?${new URLSearchParams(query)}`);

/** Runs `start` and returns the sealed state and the redirect it produced. */
async function begin(client: Client, provider: string, query = "") {
  const res = await start(client, provider, query);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  return { location, state: location.searchParams.get("state")! };
}

const oauthError = (res: { status: number; headers: Headers }) => {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${APP_URL}/connections`);
  return loc.searchParams.get("oauth_error");
};

const orgConnections = () => ctx.owner.db.select().from(connections).where(eq(connections.orgId, owner.orgId));

describe("OAuth connect: start", () => {
  it("advertises which providers can use OAuth here", async () => {
    const res = await owner.client.get<ConnectorInfo[]>("/connectors");
    const by = Object.fromEntries(res.body.map((c) => [c.provider, c]));
    expect(by.hubspot?.oauth).toEqual({ configured: true, params: [] });
    expect(by.salesforce?.oauth?.params).toEqual([
      expect.objectContaining({ key: "environment", options: ["login", "test"] }),
    ]);
    expect(by.help_scout?.oauth?.configured).toBe(false);
    expect(by.zendesk?.oauth).toBeUndefined();
  });

  it("redirects an admin to the provider with a sealed state and a browser-bound nonce cookie", async () => {
    const res = await start(owner.client, "hubspot", "name=Support%20HubSpot");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("hs-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/api/v1/connections/oauth/hubspot/callback",
    );
    expect(loc.searchParams.get("scope")).toContain("tickets");
    // The state is opaque (encrypted): no org id, user id or secrets in the clear.
    const state = loc.searchParams.get("state")!;
    expect(state).toMatch(/^v1\.k1\./);
    expect(state).not.toContain(owner.orgId);
    expect(loc.searchParams.has("code_challenge")).toBe(false); // HubSpot: no PKCE
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("slai_oauth_nonce="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/connections\/oauth/);
  });

  it("sends a PKCE S256 challenge and validated params where the provider supports them", async () => {
    const { location } = await begin(owner.client, "salesforce", "environment=test");
    expect(location.host).toBe("test.salesforce.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(oauthError(await start(owner.client, "salesforce", "environment=evil.example"))).toBe("invalid_params");
  });

  it("refuses unconfigured providers, non-admins and signed-out visitors", async () => {
    expect(oauthError(await start(owner.client, "help_scout"))).toBe("not_configured");
    expect(oauthError(await start(owner.client, "zendesk"))).toBe("not_configured");
    expect(oauthError(await start(owner.client, "Evil.Provider"))).toBe("not_configured");
    const member = await addMember(ctx, owner.orgId, "member");
    expect(oauthError(await start(member.client, "hubspot"))).toBe("forbidden");
    expect(oauthError(await start(new Client(ctx), "hubspot"))).toBe("signed_out");
  });
});

describe("OAuth connect: callback", () => {
  it("exchanges the code and creates a connection with encrypted tokens that are never returned", async () => {
    const { state } = await begin(owner.client, "hubspot", "name=Support%20HubSpot");
    tokenRequests.length = 0;
    tokenReplies.push({
      status: 200,
      json: { access_token: "hs-access-SECRET", refresh_token: "hs-refresh-SECRET", expires_in: 1800 },
    });
    const res = await callback(owner.client, "hubspot", { code: "auth-code-1", state });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toMatch(/^\/connections\/[0-9a-f-]{36}$/);
    expect(loc.searchParams.get("connected")).toBe("1");
    // The nonce cookie is cleared once used.
    expect(res.headers.getSetCookie().some((c) => /^slai_oauth_nonce=;/.test(c) || /Max-Age=0/.test(c))).toBe(true);

    expect(tokenRequests).toEqual([
      {
        url: "https://api.hubapi.com/oauth/v1/token",
        form: {
          grant_type: "authorization_code",
          code: "auth-code-1",
          redirect_uri: "http://localhost:8787/api/v1/connections/oauth/hubspot/callback",
          client_id: "hs-client-id",
          client_secret: "hs-client-secret",
        },
      },
    ]);

    const id = loc.pathname.split("/").at(-1)!;
    const [row] = await ctx.owner.db.select().from(connections).where(eq(connections.id, id));
    expect(row!.provider).toBe("hubspot");
    expect(row!.name).toBe("Support HubSpot");
    expect(row!.credentials).toMatch(/^v1\.k1\./);
    expect(row!.credentials).not.toContain("hs-access-SECRET");
    const creds = decryptJson<Record<string, unknown>>(row!.credentials, {
      keyring: ctx.deps.keyring,
      aad: AAD.connectionCredentials(id),
    });
    expect(creds).toMatchObject({
      accessToken: "hs-access-SECRET",
      refreshToken: "hs-refresh-SECRET",
      clientId: "hs-client-id",
      expiresAt: expect.any(Number),
    });
    // HubSpot signs webhooks with its own secret: none is generated.
    expect(row!.webhookSecret).toBeNull();

    const detail = await owner.client.get<Connection>(`/connections/${id}`);
    const list = await owner.client.get("/connections");
    for (const body of [detail.body, list.body]) {
      expect(JSON.stringify(body)).not.toMatch(/SECRET|v1\.k1\./);
    }
    const [audit] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, "connection.created")));
    expect(audit!.actorId).toBe(owner.userId);
    expect(audit!.metadata).toEqual({ provider: "hubspot", name: "Support HubSpot", via: "oauth" });
    expect(JSON.stringify(audit!.metadata)).not.toContain("SECRET");
    const [job] = await ctx.owner.client`select name from pgboss.job where data->>'connectionId' = ${id}`;
    expect(job?.name).toBe("sync-connection");
  });

  it("sends the PKCE verifier that matches the challenge", async () => {
    const { location, state } = await begin(owner.client, "salesforce", "environment=login");
    tokenRequests.length = 0;
    tokenReplies.push({
      status: 200,
      json: { access_token: "sf-at", refresh_token: "sf-rt", instance_url: "https://acme.my.salesforce.com" },
    });
    const res = await callback(owner.client, "salesforce", { code: "c2", state });
    expect(new URL(res.headers.get("location")!).searchParams.get("connected")).toBe("1");
    const verifier = tokenRequests[0]!.form.code_verifier!;
    expect(tokenRequests[0]!.url).toBe("https://login.salesforce.com/services/oauth2/token");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(location.searchParams.get("code_challenge"));
  });

  it("rejects a tampered, replayed, cross-provider or expired state and creates nothing", async () => {
    const before = (await orgConnections()).length;
    const { state } = await begin(owner.client, "hubspot");
    const flipped = state.slice(0, -3) + (state.at(-3) === "A" ? "B" : "A") + state.slice(-2);
    expect(oauthError(await callback(owner.client, "hubspot", { code: "x", state: flipped }))).toBe("invalid_state");
    expect(oauthError(await callback(owner.client, "hubspot", { code: "x", state: "garbage" }))).toBe("invalid_state");
    expect(oauthError(await callback(owner.client, "hubspot", { code: "x" }))).toBe("invalid_state");

    // Same signed-in user, but another browser (no nonce cookie from the start).
    const { state: s2 } = await begin(owner.client, "hubspot");
    const otherBrowser = new Client(ctx);
    otherBrowser.cookie = owner.client.cookie;
    expect(oauthError(await callback(otherBrowser, "hubspot", { code: "x", state: s2 }))).toBe("invalid_state");
    // A HubSpot state presented to the Salesforce callback.
    expect(oauthError(await callback(owner.client, "salesforce", { code: "x", state: s2 }))).toBe("invalid_state");

    // Expired.
    const { state: s3 } = await begin(owner.client, "hubspot");
    ctx.clock.now = new Date(Date.now() + 11 * 60_000);
    try {
      expect(oauthError(await callback(owner.client, "hubspot", { code: "x", state: s3 }))).toBe("invalid_state");
    } finally {
      ctx.clock.now = null;
    }
    expect(tokenRequests.filter((r) => r.form.code === "x")).toHaveLength(0);
    expect((await orgConnections()).length).toBe(before);
  });

  it("requires the same admin and org that started the flow", async () => {
    const { state } = await begin(owner.client, "hubspot");
    const nonce = owner.client.jar.get("slai_oauth_nonce")!;
    const otherAdmin = await addMember(ctx, owner.orgId, "admin");
    otherAdmin.client.jar.set("slai_oauth_nonce", nonce);
    expect(oauthError(await callback(otherAdmin.client, "hubspot", { code: "x", state }))).toBe("session_mismatch");
  });

  it("reports a denied consent and a failed exchange without creating anything", async () => {
    const before = (await orgConnections()).length;
    const { state } = await begin(owner.client, "hubspot");
    expect(oauthError(await callback(owner.client, "hubspot", { error: "access_denied", state }))).toBe("denied");
    const { state: s2 } = await begin(owner.client, "hubspot");
    tokenReplies.push({ status: 400, json: { error: "invalid_grant" } });
    expect(oauthError(await callback(owner.client, "hubspot", { code: "bad", state: s2 }))).toBe("exchange_failed");
    // A token response the connector can't use (Salesforce without a refresh token).
    const { state: s3 } = await begin(owner.client, "salesforce", "environment=login");
    tokenReplies.push({ status: 200, json: { access_token: "only" } });
    expect(oauthError(await callback(owner.client, "salesforce", { code: "c", state: s3 }))).toBe("exchange_failed");
    expect((await orgConnections()).length).toBe(before);
  });
});

describe("webhook secret reveal", () => {
  let slaiConn: Connection;
  let providerConn: string;

  beforeAll(async () => {
    const res = await owner.client.post<Connection>("/connections", {
      provider: "zendesk",
      name: "Fake Zendesk",
      credentials: { subdomain: "acme", token: "zd-token-123" },
    });
    slaiConn = res.body;
    const { state } = await begin(owner.client, "hubspot", "name=Hooks");
    tokenReplies.push({ status: 200, json: { access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 } });
    const cb = await callback(owner.client, "hubspot", { code: "c3", state });
    providerConn = new URL(cb.headers.get("location")!).pathname.split("/").at(-1)!;
  });

  const revealAudits = (id: string) =>
    ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, "connection.webhook_secret_revealed")));

  it("shows an admin the URL, slai's secret and the setup steps, and audits it", async () => {
    const [row] = await ctx.owner.db.select().from(connections).where(eq(connections.id, slaiConn.id));
    const stored = decrypt(row!.webhookSecret!, {
      keyring: ctx.deps.keyring,
      aad: AAD.connectionWebhookSecret(slaiConn.id),
    });
    const res = await owner.client.post<WebhookSecretReveal>(`/connections/${slaiConn.id}/webhook-secret/reveal`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      webhookUrl: `http://localhost:8787/api/v1/webhooks/${slaiConn.id}`,
      secretSource: "slai",
      secret: stored,
      configured: true,
      steps: [],
    });
    const audits = await revealAudits(slaiConn.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(owner.userId);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(stored);
    // Never in list or detail.
    const detail = await owner.client.get(`/connections/${slaiConn.id}`);
    const list = await owner.client.get("/connections");
    expect(JSON.stringify([detail.body, list.body])).not.toContain(stored);
  });

  it("is admin-only", async () => {
    const member = await addMember(ctx, owner.orgId, "member");
    const viewer = await addMember(ctx, owner.orgId, "viewer");
    expect((await member.client.post(`/connections/${slaiConn.id}/webhook-secret/reveal`)).status).toBe(403);
    expect((await viewer.client.post(`/connections/${slaiConn.id}/webhook-secret/reveal`)).status).toBe(403);
    expect((await new Client(ctx).post(`/connections/${slaiConn.id}/webhook-secret/reveal`)).status).toBe(401);
    // Another org can't reveal it either.
    const stranger = await signup(ctx, "Stranger");
    expect((await stranger.client.post(`/connections/${slaiConn.id}/webhook-secret/reveal`)).status).toBe(404);
    expect(await revealAudits(slaiConn.id)).toHaveLength(1);
  });

  it("takes the provider's own signing secret for providers that generate it", async () => {
    const first = await owner.client.post<WebhookSecretReveal>(`/connections/${providerConn}/webhook-secret/reveal`);
    expect(first.body).toMatchObject({ secretSource: "provider", secret: null, configured: false });
    expect(first.body.steps.join(" ")).toContain("{url}");

    const member = await addMember(ctx, owner.orgId, "member");
    expect(
      (await member.client.put(`/connections/${providerConn}/webhook-secret`, { secret: "hubspot-app-secret" })).status,
    ).toBe(403);
    expect((await owner.client.put(`/connections/${providerConn}/webhook-secret`, { secret: "short" })).status).toBe(
      400,
    );
    expect(
      (await owner.client.put(`/connections/${providerConn}/webhook-secret`, { secret: "hubspot-app-secret" })).status,
    ).toBe(204);
    // slai-generated secrets can't be overwritten this way.
    expect(
      (await owner.client.put(`/connections/${slaiConn.id}/webhook-secret`, { secret: "whatever-123" })).status,
    ).toBe(400);

    const after = await owner.client.post<WebhookSecretReveal>(`/connections/${providerConn}/webhook-secret/reveal`);
    expect(after.body).toMatchObject({ secret: null, configured: true });
    const [row] = await ctx.owner.db.select().from(connections).where(eq(connections.id, providerConn));
    expect(
      decrypt(row!.webhookSecret!, { keyring: ctx.deps.keyring, aad: AAD.connectionWebhookSecret(providerConn) }),
    ).toBe("hubspot-app-secret");
    const [set] = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, providerConn), eq(auditEvents.action, "connection.webhook_secret_set")));
    expect(set).toBeDefined();
  });
});
