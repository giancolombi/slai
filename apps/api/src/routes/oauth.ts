/**
 * "Continue with <Provider>": the OAuth2 authorization-code connect flow (T-57).
 *
 *   GET /connections/oauth/:provider/start?name=&<provider params>
 *     → 302 to the provider with a sealed state (org, user, nonce, PKCE verifier,
 *       params) and an httpOnly nonce cookie bound to this browser.
 *   GET /connections/oauth/:provider/callback?code=&state=
 *     → exchanges the code, creates the connection with encrypted tokens,
 *       audits it and 302s to the web app. Tokens are never returned.
 *
 * Both are browser navigations, so failures redirect back to the Connections
 * page with `?oauth_error=<code>` instead of rendering JSON.
 */
import { authorizeUrl, ConnectorError, exchangeCode, oauthParams } from "@slai/connectors";
import { API_BASE } from "@slai/shared";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type AppDeps, type AppEnv, type AuthContext, type Ctx, ROLE_RANK } from "../context.js";
import {
  newNonce,
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_TTL_MS,
  oauthApp,
  openState,
  pkcePair,
  sameNonce,
  sealState,
} from "../oauth.js";
import { insertConnection } from "./connections.js";

const COOKIE_PATH = `${API_BASE}/connections/oauth`;
const PROVIDER = /^[a-z_]{1,40}$/;

export function oauthRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const appUrl = deps.env.APP_URL.replace(/\/$/, "");
  const redirectUri = (provider: string) => `${deps.env.API_URL.replace(/\/$/, "")}${COOKIE_PATH}/${provider}/callback`;
  const secure = deps.env.NODE_ENV === "production";

  const fail = (c: Ctx, code: string) => {
    deleteCookie(c, OAUTH_NONCE_COOKIE, { path: COOKIE_PATH, secure });
    return c.redirect(`${appUrl}/connections?oauth_error=${encodeURIComponent(code)}`, 302);
  };
  /** A fully signed-in admin (MFA done), or null. */
  const admin = (a: AuthContext | null) =>
    a && a.mfa === "satisfied" && ROLE_RANK[a.role] >= ROLE_RANK.admin ? a : null;

  const resolve = (provider: string) => {
    if (!PROVIDER.test(provider)) return null;
    const def = deps.connectors.get(provider);
    const cfg = def?.oauth ? oauthApp(deps.env, provider) : null;
    return def?.oauth && cfg ? { def, meta: def.oauth, cfg } : null;
  };

  app.get("/:provider/start", (c) => {
    const provider = c.req.param("provider");
    const a = admin(c.get("auth"));
    if (!a) return fail(c, c.get("auth") ? "forbidden" : "signed_out");
    const r = resolve(provider);
    if (!r) return fail(c, "not_configured");
    const q = c.req.query();
    let params: Record<string, string>;
    try {
      params = oauthParams(r.meta, q);
    } catch {
      return fail(c, "invalid_params");
    }
    const name = (q.name ?? "").trim().slice(0, 120) || r.def.displayName;
    const nonce = newNonce();
    const pkce = r.meta.pkce ? pkcePair() : null;
    const state = sealState(deps.keyring, {
      provider,
      orgId: a.orgId,
      userId: a.user.id,
      nonce,
      verifier: pkce?.verifier ?? null,
      params,
      name,
      exp: deps.now().getTime() + OAUTH_STATE_TTL_MS,
    });
    setCookie(c, OAUTH_NONCE_COOKIE, nonce, {
      path: COOKIE_PATH,
      httpOnly: true,
      secure,
      // Lax: sent on the provider's top-level redirect back to us.
      sameSite: "Lax",
      maxAge: OAUTH_STATE_TTL_MS / 1000,
    });
    return c.redirect(
      authorizeUrl(r.meta, {
        clientId: r.cfg.clientId,
        redirectUri: redirectUri(provider),
        state,
        params,
        codeChallenge: pkce?.challenge ?? null,
      }),
      302,
    );
  });

  app.get("/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const q = c.req.query();
    if (q.error) return fail(c, q.error === "access_denied" ? "denied" : "provider_error");
    const r = resolve(provider);
    if (!r) return fail(c, "not_configured");
    const state = q.state ? openState(deps.keyring, q.state, deps.now().getTime()) : null;
    // Tampered, expired, replayed from another browser, or meant for another provider.
    if (!state || state.provider !== provider || !sameNonce(getCookie(c, OAUTH_NONCE_COOKIE), state.nonce)) {
      deps.logger.warn({ requestId: c.get("requestId"), provider, ip: c.get("ip") }, "oauth state rejected");
      return fail(c, "invalid_state");
    }
    const a = admin(c.get("auth"));
    // The flow must finish as the admin, in the org, that started it.
    if (!a || a.user.id !== state.userId || a.orgId !== state.orgId) return fail(c, "session_mismatch");
    if (!q.code || q.code.length > 2048) return fail(c, "invalid_code");

    let credentials: unknown;
    try {
      const token = await exchangeCode(r.meta, {
        fetch: deps.fetch,
        code: q.code,
        redirectUri: redirectUri(provider),
        clientId: r.cfg.clientId,
        clientSecret: r.cfg.clientSecret,
        codeVerifier: state.verifier,
        params: state.params,
      });
      credentials = r.meta.toCredentials({
        token,
        clientId: r.cfg.clientId,
        clientSecret: r.cfg.clientSecret,
        params: state.params,
        now: deps.now().getTime(),
      });
    } catch (e) {
      // The token response is never logged; only the error kind.
      deps.logger.warn(
        { requestId: c.get("requestId"), provider, kind: e instanceof ConnectorError ? e.kind : "error" },
        "oauth code exchange failed",
      );
      return fail(c, "exchange_failed");
    }
    const parsed = r.def.credentialsSchema.safeParse(credentials);
    if (!parsed.success) return fail(c, "invalid_credentials");

    const row = await deps.orgDb.withOrg(a.orgId, (tx) =>
      insertConnection(deps, tx, c, {
        orgId: a.orgId,
        userId: a.user.id,
        def: r.def,
        name: state.name,
        credentials: parsed.data,
        config: {},
        via: "oauth",
      }),
    );
    deleteCookie(c, OAUTH_NONCE_COOKIE, { path: COOKIE_PATH, secure });
    return c.redirect(`${appUrl}/connections/${row.id}?connected=1`, 302);
  });

  return app;
}
