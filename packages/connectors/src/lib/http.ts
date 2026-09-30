/**
 * A small JSON HTTP client over the injected `fetch`. It adds auth headers,
 * enforces a timeout through AbortSignal, and maps HTTP failures onto
 * `ConnectorError` kinds. 429 and 503 become `rate_limited` with the delay the
 * server asked for (Retry-After, or a vendor reset header), so the worker can
 * back off. Connectors never retry on their own; the worker owns retries.
 */
import { ConnectorError } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpOptions {
  baseUrl: string;
  fetch: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Clock for HTTP-date Retry-After values. Defaults to Date.now. */
  now?: () => number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Parses Retry-After: either delta-seconds or an HTTP date. Returns ms, or null
 * when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Some vendors send a reset instant instead of Retry-After (Intercom:
 * X-RateLimit-Reset as epoch seconds). Used only when Retry-After is absent.
 */
function parseResetHeader(headers: Headers, now: number): number | null {
  const reset = headers.get("x-ratelimit-reset");
  if (!reset || !/^\d+$/.test(reset.trim())) return null;
  const n = Number(reset);
  // Epoch seconds (large) vs. seconds-until-reset (small).
  if (n > 1_000_000_000) return Math.max(0, n * 1000 - now);
  return n * 1000;
}

export function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

export class HttpClient {
  constructor(private readonly opts: HttpOptions) {}

  get<T>(path: string, o: RequestOptions = {}) {
    return this.request<T>("GET", path, o).then((r) => r.data);
  }
  post<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>("POST", path, { ...o, body }).then((r) => r.data);
  }
  put<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>("PUT", path, { ...o, body }).then((r) => r.data);
  }
  patch<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>("PATCH", path, { ...o, body }).then((r) => r.data);
  }

  async request<T>(method: Method, path: string, o: RequestOptions = {}): Promise<HttpResponse<T>> {
    const url = buildUrl(this.opts.baseUrl, path, o.query);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout;
    const headers: Record<string, string> = { Accept: "application/json", ...this.opts.headers, ...o.headers };
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await this.opts.fetch(url, { method, headers, body, signal });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError") throw new ConnectorError(`${method} ${redact(url)} timed out`, "upstream");
      if (name === "AbortError") throw new ConnectorError(`${method} ${redact(url)} aborted`, "upstream");
      throw new ConnectorError(`${method} ${redact(url)} failed: ${(err as Error)?.message ?? err}`, "upstream");
    }

    if (!res.ok) throw await toError(method, url, res, this.opts.now?.() ?? Date.now());

    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ConnectorError(`${method} ${redact(url)} returned non-JSON`, "upstream");
      }
    }
    return { status: res.status, headers: res.headers, data: data as T };
  }
}

/** Drops the query string: it can carry tokens (e.g. Freshdesk webhook tokens). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

async function toError(method: string, url: string, res: Response, now: number): Promise<ConnectorError> {
  const what = `${method} ${redact(url)} → ${res.status}`;
  // Body is read only for a short, non-secret detail; never echoed wholesale.
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    // ignore
  }
  const msg = detail ? `${what}: ${detail}` : what;
  if (res.status === 429 || res.status === 503) {
    const retry = parseRetryAfter(res.headers.get("retry-after"), now) ?? parseResetHeader(res.headers, now);
    return new ConnectorError(msg, "rate_limited", retry);
  }
  if (res.status === 401 || res.status === 403) return new ConnectorError(msg, "auth");
  if (res.status === 404) return new ConnectorError(msg, "not_found");
  if (res.status === 400 || res.status === 409 || res.status === 422) return new ConnectorError(msg, "invalid");
  return new ConnectorError(msg, "upstream");
}

// ---------------------------------------------------------------- shared auth and rate-limit plumbing (T-26)

export interface TokenRequestOptions {
  fetch: typeof fetch;
  /** The OAuth token endpoint. */
  url: string;
  /** Grant parameters (grant_type, client_id, client_secret, refresh_token, code, ...). */
  params: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Where the parameters go: a form-encoded body (RFC 6749, the default) or the
   * query string (Zoho documents its token endpoint that way).
   */
  paramsIn?: "body" | "query";
  /** Prefix for error messages. Defaults to `POST <url without query>`. */
  label?: string;
  /** Message for a rejected grant (400/401/403). Defaults to `<label> → <status>[: <oauth error code>]`. */
  authMessage?: string;
  timeoutMs?: number;
}

/**
 * POSTs an OAuth token request and returns the parsed JSON body. HttpClient is
 * JSON-only, so this is a minimal form POST with matching error mapping:
 * 429/503 → rate_limited (Retry-After honored), 400/401/403 → auth (a bad
 * client or grant), anything else → upstream. Only the OAuth `error` code is
 * echoed, never the request (it carries the client secret).
 */
export async function requestToken(o: TokenRequestOptions): Promise<unknown> {
  const inQuery = o.paramsIn === "query";
  const form = new URLSearchParams(o.params);
  const url = inQuery ? buildUrl(o.url, "", Object.fromEntries(form)) : o.url;
  const label = o.label ?? `POST ${redact(o.url)}`;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!inQuery) headers["Content-Type"] = "application/x-www-form-urlencoded";
  let res: Response;
  try {
    res = await o.fetch(url, {
      method: "POST",
      headers,
      body: inQuery ? undefined : form,
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
  } catch (err) {
    throw new ConnectorError(`${label} failed: ${(err as Error)?.message ?? err}`, "upstream");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const code = (text.match(/"error"\s*:\s*"([^"]+)"/)?.[1] ?? "").slice(0, 60);
    const msg = `${label} → ${res.status}${code ? `: ${code}` : ""}`;
    if (res.status === 429 || res.status === 503) {
      throw new ConnectorError(msg, "rate_limited", parseRetryAfter(res.headers.get("retry-after")));
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ConnectorError(o.authMessage ?? msg, "auth");
    }
    throw new ConnectorError(msg, "upstream");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConnectorError(`${label} returned non-JSON`, "upstream");
  }
}

export interface RateLimitRule {
  /** Which non-2xx statuses to inspect, e.g. 403 (GitHub, Salesforce) or 400 (Linear). */
  statuses: readonly number[] | ((status: number) => boolean);
  /** Read the body before testing (it is re-attached to the response either way). */
  readBody?: boolean;
  /** True when this response is really a rate limit. `body` is "" unless `readBody`. */
  test: (res: Response, body: string) => boolean;
  /** Delay to advertise when the vendor sends no Retry-After (e.g. from its reset headers). */
  retryAfterMs?: (headers: Headers) => number | null;
}

/**
 * Some vendors signal rate limits with a status HttpClient maps elsewhere
 * (GitHub and Salesforce: 403 → auth; Linear: 400 → invalid). This fetch
 * wrapper rewrites such responses to 429, adding Retry-After when the rule can
 * compute one, so HttpClient's own mapping yields `rate_limited` with a delay.
 */
export function detectRateLimits(inner: typeof fetch, rule: RateLimitRule): typeof fetch {
  const inspects = (s: number) => (typeof rule.statuses === "function" ? rule.statuses(s) : rule.statuses.includes(s));
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await inner(input, init);
    if (res.ok || !inspects(res.status)) return res;
    const body = rule.readBody ? await res.text() : "";
    const rebuild = (status: number, statusText: string, headers: Headers) =>
      new Response(rule.readBody ? body : res.body, { status, statusText, headers });
    if (!rule.test(res, body)) return rule.readBody ? rebuild(res.status, res.statusText, res.headers) : res;
    const headers = new Headers(res.headers);
    const ms = rule.retryAfterMs?.(res.headers) ?? null;
    if (!headers.has("retry-after") && ms !== null) headers.set("retry-after", String(Math.ceil(ms / 1000)));
    return rebuild(429, "Too Many Requests", headers);
  }) as typeof fetch;
}

/** An HTTP 401 surfaced by HttpClient (as opposed to a 403 or a rejected grant). */
export function isUnauthorized(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError && err.kind === "auth" && / → 401\b/.test(err.message);
}

/**
 * Runs `run`; when it fails with an expired or revoked token (`when`, by
 * default an HTTP 401), calls `onAuthFailure` (drop or refetch the token) and
 * runs it exactly once more. Auth plumbing only; the worker owns retries.
 */
export async function retryOnceOnAuth<T>(
  run: () => Promise<T>,
  o: { onAuthFailure: () => void | Promise<void>; when?: (err: ConnectorError) => boolean },
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ConnectorError) || !(o.when ? o.when(err) : isUnauthorized(err))) throw err;
    await o.onAuthFailure();
    return run();
  }
}
