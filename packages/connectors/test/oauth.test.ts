import { describe, expect, it, vi } from "vitest";
import { hubspot } from "../src/connectors/hubspot.js";
import { getConnector, listConnectors } from "../src/index.js";
import { authorizeUrl, exchangeCode, oauthParams, readTokens, tokenSession } from "../src/lib/oauth.js";
import { ConnectorError } from "../src/types.js";
import { fakeFetch, rejection } from "./helpers/fake-fetch.js";

const zendeskOAuth = getConnector("zendesk")!.oauth!;

/** A fetch that records form bodies and answers each call from `replies` in order. */
function formFetch(replies: { status?: number; json: unknown }[]) {
  const seen: { url: string; form: Record<string, string>; auth: string | null }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    seen.push({ url: String(input), form: body, auth: new Headers(init?.headers).get("authorization") });
    const r = replies.shift();
    if (!r) throw new Error(`unexpected ${input}`);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, seen };
}

describe("OAuth metadata", () => {
  it("builds the authorize URL with state, scopes, PKCE and provider params", () => {
    const url = new URL(
      authorizeUrl(zendeskOAuth, {
        clientId: "slai_zd",
        redirectUri: "https://api.slai.dev/api/v1/connections/oauth/zendesk/callback",
        state: "sealed-state",
        codeChallenge: "chal",
        params: oauthParams(zendeskOAuth, { subdomain: "acme" }),
      }),
    );
    expect(url.origin + url.pathname).toBe("https://acme.zendesk.com/oauth/authorizations/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "slai_zd",
      redirect_uri: "https://api.slai.dev/api/v1/connections/oauth/zendesk/callback",
      state: "sealed-state",
      scope: "read write",
      code_challenge: "chal",
      code_challenge_method: "S256",
    });
  });

  it("rejects params that could redirect the flow elsewhere", () => {
    for (const subdomain of ["", "evil.com/x", "a.b", "acme#", "ACME$"]) {
      expect(() => oauthParams(zendeskOAuth, { subdomain })).toThrow(ConnectorError);
    }
    const zoho = getConnector("zoho_desk")!.oauth!;
    expect(oauthParams(zoho, { dataCenter: "com.au", orgId: "600" })).toEqual({ dataCenter: "com.au", orgId: "600" });
    expect(() => oauthParams(zoho, { dataCenter: "evil.com", orgId: "600" })).toThrow(ConnectorError);
    const zohoUrl = new URL(
      authorizeUrl(zoho, {
        clientId: "c",
        redirectUri: "https://r",
        state: "s",
        params: { dataCenter: "ca", orgId: "1" },
      }),
    );
    expect(zohoUrl.host).toBe("accounts.zohocloud.ca");
    expect(zohoUrl.searchParams.get("scope")).toBe("Desk.tickets.ALL,Desk.basic.READ,Desk.settings.READ");
    expect(zohoUrl.searchParams.get("access_type")).toBe("offline");
    // No PKCE parameters for providers that don't support it.
    expect(zohoUrl.searchParams.has("code_challenge")).toBe(false);
  });

  it("exchanges the code with a form-encoded authorization_code grant", async () => {
    const { f, seen } = formFetch([{ json: { access_token: "at", refresh_token: "rt", expires_in: 7200 } }]);
    const token = await exchangeCode(zendeskOAuth, {
      fetch: f,
      code: "the-code",
      redirectUri: "https://r.test/cb",
      clientId: "cid",
      clientSecret: "csecret",
      codeVerifier: "verifier",
      params: { subdomain: "acme" },
    });
    expect(seen[0]).toEqual({
      url: "https://acme.zendesk.com/oauth/tokens",
      auth: null,
      form: {
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: "https://r.test/cb",
        client_id: "cid",
        client_secret: "csecret",
        code_verifier: "verifier",
      },
    });
    expect(readTokens(token, 1_000)).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 7_201_000 });
    const bad = formFetch([{ status: 400, json: { error: "invalid_grant" } }]);
    const err = await rejection(
      exchangeCode(zendeskOAuth, {
        ...{ code: "x", redirectUri: "r", clientId: "c", clientSecret: "s" },
        fetch: bad.f,
        params: { subdomain: "acme" },
      }),
    );
    expect(err.kind).toBe("auth");
    const zohoStyle = formFetch([{ json: { error: "invalid_code" } }]);
    const zErr = await rejection(
      exchangeCode(zendeskOAuth, {
        code: "x",
        redirectUri: "r",
        clientId: "c",
        clientSecret: "s",
        fetch: zohoStyle.f,
        params: { subdomain: "acme" },
      }),
    );
    expect(zErr.kind).toBe("auth");
  });

  it("every OAuth provider's credentials validate against its own schema", () => {
    const token = {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      instance_url: "https://acme.my.salesforce.com",
      token: "at",
    };
    const params: Record<string, Record<string, string>> = {
      zendesk: { subdomain: "acme" },
      salesforce: { environment: "login" },
      zoho_desk: { dataCenter: "eu", orgId: "600" },
    };
    const withOAuth = listConnectors().filter((d) => d.oauth);
    expect(withOAuth.map((d) => d.provider).sort()).toEqual([
      "help_scout",
      "hubspot",
      "intercom",
      "salesforce",
      "zendesk",
      "zoho_desk",
    ]);
    for (const def of withOAuth) {
      const meta = def.oauth!;
      expect(typeof meta.tokenUrl === "string" ? meta.tokenUrl : meta.tokenUrl(params[def.provider] ?? {})).toMatch(
        /^https:\/\//,
      );
      const creds = meta.toCredentials({
        token,
        clientId: "cid",
        clientSecret: "cs",
        params: params[def.provider] ?? {},
        now: 0,
      });
      expect(def.credentialsSchema.safeParse(creds).success, def.provider).toBe(true);
    }
  });

  it("every webhook connector documents its setup", () => {
    for (const def of listConnectors().filter((d) => d.supportsWebhooks)) {
      expect(def.webhookSetup?.steps.length, def.provider).toBeGreaterThan(0);
      expect(def.webhookSetup!.steps.join(" "), def.provider).toContain("{url}");
      if (def.webhookSetup!.secret === "slai")
        expect(def.webhookSetup!.steps.join(" "), def.provider).toContain("{secret}");
    }
  });
});

describe("tokenSession", () => {
  it("uses the stored token until it nears expiry, then refreshes and reports rotated tokens", async () => {
    let now = 0;
    const { f, seen } = formFetch([{ json: { access_token: "at2", refresh_token: "rt2", expires_in: 1800 } }]);
    const onRefresh = vi.fn();
    const s = tokenSession({
      fetch: f,
      tokenUrl: "https://auth.test/token",
      clientId: "cid",
      clientSecret: "cs",
      initial: { accessToken: "at1", refreshToken: "rt1", expiresAt: 600_000 },
      onRefresh,
      now: () => now,
    });
    expect(await s.token()).toBe("at1");
    now = 550_000; // within the skew
    expect(await s.token()).toBe("at2");
    expect(seen[0]?.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt1",
      client_id: "cid",
      client_secret: "cs",
    });
    expect(onRefresh).toHaveBeenCalledWith({ accessToken: "at2", refreshToken: "rt2", expiresAt: 550_000 + 1_800_000 });
    expect(await s.token()).toBe("at2");
  });

  it("keeps a non-expiring token and fails clearly when an expired token cannot be refreshed", async () => {
    const forever = tokenSession({
      fetch: fakeFetch([]).fetch,
      tokenUrl: "https://a.test",
      initial: { accessToken: "t" },
    });
    expect(await forever.token()).toBe("t");
    const stuck = tokenSession({
      fetch: fakeFetch([]).fetch,
      tokenUrl: "https://a.test",
      initial: { refreshToken: "r" },
      now: () => 0,
    });
    expect((await rejection(stuck.token())).kind).toBe("auth");
  });
});

describe("HubSpot with OAuth tokens", () => {
  it("refreshes an expired access token, retries a 401 once, and reports new credentials", async () => {
    const seen: string[] = [];
    const replies = [
      { url: "https://api.hubapi.com/oauth/v1/token", json: { access_token: "fresh", expires_in: 1800 } },
      { url: "https://api.hubapi.com/account-info/v3/details", status: 401, json: { message: "expired" } },
      { url: "https://api.hubapi.com/oauth/v1/token", json: { access_token: "fresher", expires_in: 1800 } },
      { url: "https://api.hubapi.com/account-info/v3/details", json: { portalId: 42, uiDomain: "app.hubspot.com" } },
    ];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const next = replies.shift()!;
      expect(String(input)).toBe(next.url);
      seen.push(new Headers(init?.headers).get("authorization") ?? "(form)");
      return new Response(JSON.stringify(next.json), { status: next.status ?? 200 });
    }) as typeof fetch;
    const refreshed = vi.fn();
    const client = hubspot.create({
      credentials: { accessToken: "stale", refreshToken: "rt", expiresAt: 1, clientId: "cid", clientSecret: "cs" },
      config: {},
      mapping: hubspot.defaultMapping,
      fetch: f,
      onCredentialsRefreshed: refreshed,
    });
    await client.testConnection();
    expect(seen).toEqual(["(form)", "Bearer fresh", "(form)", "Bearer fresher"]);
    expect(refreshed).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessToken: "fresher", refreshToken: "rt", clientId: "cid", clientSecret: "cs" }),
    );
  });

  it("keeps sending a private-app token as is", async () => {
    const f = fakeFetch([
      {
        method: "GET",
        url: "https://api.hubapi.com/account-info/v3/details",
        headers: { authorization: "Bearer pat" },
        json: { portalId: 42 },
      },
    ]);
    const client = hubspot.create({
      credentials: { accessToken: "pat" },
      config: {},
      mapping: hubspot.defaultMapping,
      fetch: f.fetch,
    });
    await client.testConnection();
    expect(f.unused()).toEqual([]);
  });
});
