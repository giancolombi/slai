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
