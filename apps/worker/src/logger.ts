import { type DestinationStream, type Logger, pino } from "pino";

/** Paths pino must never print. Ticket content and secrets never go into log objects; this is defense in depth. */
export const REDACT_PATHS = [
  "*.password",
  "*.credentials",
  "*.token",
  "*.secret",
  "*.webhookSecret",
  "*.apiKey",
  "*.target",
  "*.body",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
];

export type { Logger };

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: "[redacted]" }, base: { service: "slai-worker" } },
    destination,
  );
}

/** Error text safe to log or store: no bound query params, bounded length. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\nparams:")[0]!.slice(0, 500);
}
