/**
 * A fake `fetch` for connector tests. Each route asserts the method, the URL
 * (path + query, order-insensitive), and any headers the connector must send.
 * Unmatched requests fail the test loudly: no network, ever.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorError } from "../../src/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// biome-ignore lint/suspicious/noExplicitAny: fixtures are free-form JSON
export function fixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as T;
}

export function fixtureText(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

/** Awaits a promise that must reject, and returns the ConnectorError it rejected with. */
export async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    return e as ConnectorError;
  }
  throw new Error("expected rejection");
}

export interface Route {
  method: string;
  /** Full URL; query params are compared order-insensitively. RegExp matches the full URL. */
  url: string | RegExp;
  headers?: Record<string, string | RegExp>;
  /** Inspect/assert the parsed JSON request body. */
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are free-form JSON
  body?: (body: any) => void;
  status?: number;
  json?: unknown;
  /** Path under test/fixtures, served as the JSON response. */
  fixture?: string;
  responseHeaders?: Record<string, string>;
  /** Route can match many times (default: once). */
  repeat?: boolean;
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function normalize(u: string): string {
  const url = new URL(u);
  url.searchParams.sort();
  return url.toString();
}

export function fakeFetch(routes: Route[]) {
  const used = new Set<number>();
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers, body });

    const idx = routes.findIndex(
      (r, i) =>
        (r.repeat || !used.has(i)) &&
        r.method.toUpperCase() === method &&
        (typeof r.url === "string" ? normalize(r.url) === normalize(url) : r.url.test(url)),
    );
    if (idx === -1) throw new Error(`fake fetch: unexpected ${method} ${url}`);
    used.add(idx);
    const route = routes[idx]!;
    for (const [k, v] of Object.entries(route.headers ?? {})) {
      const got = headers[k.toLowerCase()];
      const ok = typeof v === "string" ? got === v : got !== undefined && v.test(got);
      if (!ok) throw new Error(`fake fetch: ${method} ${url} header ${k} = ${got}, expected ${v}`);
    }
    route.body?.(body);
    const payload = route.fixture
      ? fixtureText(route.fixture)
      : route.json === undefined
        ? ""
        : JSON.stringify(route.json);
    return new Response(payload, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...route.responseHeaders },
    });
  };
  return {
    fetch: fn as typeof fetch,
    calls,
    unused: () => routes.filter((r, i) => !r.repeat && !used.has(i)).map((r) => `${r.method} ${r.url}`),
  };
}
