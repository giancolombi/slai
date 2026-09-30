import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import { clientIp, type TrustProxy } from "../client-ip.js";
import type { AppEnv } from "../context.js";
import { ApiError } from "../errors.js";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

/** Request id (honors a well-formed incoming X-Request-Id) and client IP. */
export function requestContext(opts: { trustProxy: TrustProxy }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    c.set("auth", null);
    let remote: string | null = null;
    try {
      remote = getConnInfo(c).remote.address ?? null;
    } catch {
      remote = null; // not running under node-server (tests)
    }
    c.set("ip", clientIp(c.req.header("x-forwarded-for"), remote, opts.trustProxy));
    c.header("X-Request-Id", id);
    await next();
  };
}

/** API responses are never cached by browsers or proxies. */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
};

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for cookie-authenticated requests, on top of SameSite=Lax:
 * every state-changing request must carry `X-Requested-With: slai` (a custom
 * header forces a CORS preflight cross-origin), and when the browser sends
 * Origin or Sec-Fetch-Site they must say the request came from APP_URL.
 * Public webhook routes are exempt (no cookie auth; signature-verified).
 */
export function csrf(opts: { appUrl: string; exempt: (path: string) => boolean }): MiddlewareHandler<AppEnv> {
  const allowed = new URL(opts.appUrl).origin;
  return async (c, next) => {
    if (SAFE.has(c.req.method) || opts.exempt(c.req.path)) return next();
    if (c.req.header("x-requested-with") !== "slai") {
      throw new ApiError(403, "csrf", "This request was blocked for your security. Refresh the page and try again.");
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== allowed) {
      throw new ApiError(403, "csrf", "Cross-origin request rejected.");
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      throw new ApiError(403, "csrf", "Cross-site request rejected.");
    }
    await next();
  };
}
