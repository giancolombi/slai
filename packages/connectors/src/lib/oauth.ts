/**
 * OAuth2 plumbing shared by connectors and the API's connect flow (T-57):
 * building the authorize URL, exchanging the code, reading token responses,
 * and a refreshing bearer-token session for connectors whose access tokens
 * expire. Pure HTTP over an injected `fetch`; nothing is persisted here.
 */
import { z } from "zod";
import { type ConnectorContext, ConnectorError, type OAuthMetadata } from "../types.js";
import { requestToken } from "./http.js";

/**
 * Credential fields stored for a connection made through the OAuth flow, next
 * to the access token. The client id and secret are the platform's OAuth app,
 * kept (encrypted) with the connection so the worker can refresh.
 */
export const oauthTokenFields = {
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().positive().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
};

interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

/**
 * A `fetch` that authenticates with the connection's (possibly refreshing)
 * bearer token and reports refreshed credentials through the context.
 */
export function oauthFetch<C extends StoredTokens>(ctx: ConnectorContext<C>, creds: C, tokenUrl: string): typeof fetch {
  const session = tokenSession({
    fetch: ctx.fetch,
    signal: ctx.signal,
    tokenUrl,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    initial: creds,
    onRefresh: (t) => ctx.onCredentialsRefreshed?.({ ...creds, ...t }),
  });
  return bearerFetch(ctx.fetch, session);
}

/** Refresh this long before the advertised expiry. */
export const TOKEN_SKEW_MS = 60_000;

/** Validates the user-supplied params (they end up in provider URLs). */
export function oauthParams(meta: OAuthMetadata, raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of meta.params ?? []) {
    const v = typeof raw[p.key] === "string" ? (raw[p.key] as string).trim() : "";
    const ok = p.options ? p.options.includes(v) : new RegExp(`^(?:${p.pattern})$`).test(v);
    if (!v || !ok) throw new ConnectorError(`${p.label} is not valid.`, "invalid");
    out[p.key] = v;
  }
  return out;
}

/** Fills `{key}` placeholders (or calls the builder) with already-validated params. */
export function fillUrl(template: OAuthMetadata["tokenUrl"], params: Record<string, string>): string {
  if (typeof template === "function") return new URL(template(params)).toString();
  const url = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new ConnectorError(`missing OAuth parameter ${k}`, "invalid");
    return encodeURIComponent(v);
  });
  return new URL(url).toString();
}

export function authorizeUrl(
  meta: OAuthMetadata,
  o: {
    clientId: string;
    redirectUri: string;
    state: string;
    params: Record<string, string>;
    /** S256 challenge; sent only when the provider supports PKCE. */
    codeChallenge?: string | null;
  },
): string {
  const url = new URL(fillUrl(meta.authorizeUrl, o.params));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("state", o.state);
  if (meta.scopes.length) url.searchParams.set("scope", meta.scopes.join(meta.scopeSeparator ?? " "));
  if (meta.pkce && o.codeChallenge) {
    url.searchParams.set("code_challenge", o.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(meta.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/** Exchanges an authorization code for tokens; returns the raw token response. */
export async function exchangeCode(
  meta: OAuthMetadata,
  o: {
    fetch: typeof fetch;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    params: Record<string, string>;
    codeVerifier?: string | null;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    client_secret: o.clientSecret,
  };
  if (meta.pkce && o.codeVerifier) form.code_verifier = o.codeVerifier;
  const data = await requestToken({
    fetch: o.fetch,
    signal: o.signal,
    url: fillUrl(meta.tokenUrl, o.params),
    params: form,
  });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConnectorError("OAuth token response was not an object", "upstream");
  }
  const rec = data as Record<string, unknown>;
  // Some providers (Zoho) answer a bad code with 200 and an error field.
  if (typeof rec.error === "string") throw new ConnectorError(`OAuth: ${rec.error.slice(0, 60)}`, "auth");
  return rec;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the token does not expire. */
  expiresAt?: number;
}

/** Reads the standard fields of a token response (`token` is Intercom's name for it). */
export function readTokens(token: Record<string, unknown>, now: number): OAuthTokens {
  const access = token.access_token ?? token.token;
  if (typeof access !== "string" || !access) throw new ConnectorError("OAuth: no access token", "upstream");
  const out: OAuthTokens = { accessToken: access };
  if (typeof token.refresh_token === "string" && token.refresh_token) out.refreshToken = token.refresh_token;
  const expiresIn = Number(token.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) out.expiresAt = now + expiresIn * 1000;
  return out;
}

export interface TokenSessionOptions {
  fetch: typeof fetch;
  signal?: AbortSignal;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  initial: Partial<OAuthTokens>;
  /** Receives refreshed tokens so the caller can persist them (refresh tokens may rotate). */
  onRefresh?: (tokens: OAuthTokens) => void | Promise<void>;
  now?: () => number;
}

/**
 * A bearer-token session: returns the stored access token until it is about
 * to expire, then uses the refresh token. `invalidate` forces a refresh on the
 * next call (after a 401). Without a refresh token it simply returns the token.
 */
export function tokenSession(o: TokenSessionOptions) {
  const now = o.now ?? Date.now;
  let tokens: Partial<OAuthTokens> = { ...o.initial };
  let inflight: Promise<string> | null = null;
  const canRefresh = () => Boolean(tokens.refreshToken && o.clientId && o.clientSecret);

  const refresh = async (): Promise<string> => {
    const data = await requestToken({
      fetch: o.fetch,
      signal: o.signal,
      url: o.tokenUrl,
      params: {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken ?? "",
        client_id: o.clientId ?? "",
        client_secret: o.clientSecret ?? "",
      },
    });
    const next = readTokens((data ?? {}) as Record<string, unknown>, now());
    // Providers that don't rotate refresh tokens omit it; keep the old one.
    tokens = { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
    await o.onRefresh?.(tokens as OAuthTokens);
    return next.accessToken;
  };

  return {
    canRefresh,
    async token(): Promise<string> {
      const fresh = tokens.accessToken && (tokens.expiresAt === undefined || tokens.expiresAt - TOKEN_SKEW_MS > now());
      if (fresh) return tokens.accessToken as string;
      if (!canRefresh()) {
        if (tokens.accessToken) return tokens.accessToken;
        throw new ConnectorError("OAuth access token expired and no refresh token is stored", "auth");
      }
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      if (canRefresh()) tokens = { ...tokens, accessToken: undefined };
    },
  };
}

export type TokenSession = ReturnType<typeof tokenSession>;

/**
 * Wraps `fetch` to send `Authorization: Bearer <token>` from the session and,
 * on a 401, refresh once and resend (only when a refresh token exists).
 */
export function bearerFetch(inner: typeof fetch, session: TokenSession): typeof fetch {
  const send = async (input: Parameters<typeof fetch>[0], init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${await session.token()}`);
    return inner(input, { ...init, headers });
  };
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await send(input, init);
    if (res.status !== 401 || !session.canRefresh()) return res;
    session.invalidate();
    return send(input, init);
  }) as typeof fetch;
}
