import type { MiddlewareHandler } from "hono";
import { type DestinationStream, type Logger, pino } from "pino";
import type { AppEnv } from "./context.js";

/**
 * Paths pino must never print. Request bodies are never logged at all; this is
 * defense in depth for anything that ends up in a log object by mistake.
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "res.headers['set-cookie']",
  "headers.cookie",
  "headers.authorization",
  "*.password",
  "*.passwordHash",
  "*.password_hash",
  "*.credentials",
  "*.token",
  "*.totp",
  "*.secret",
  "*.mfaSecret",
  "*.webhookSecret",
  "*.apiKey",
  "*.target",
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: "[redacted]" }, base: { service: "slai-api" } },
    destination,
  );
}

/** Strips query parameters and bound values from DB error text before logging. */
export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\nparams:")[0]!.slice(0, 500);
}

export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const a = c.get("auth");
    logger.info(
      {
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
        userId: a?.user.id,
        orgId: a?.orgId,
        ip: c.get("ip"),
      },
      "request",
    );
  };
}
