/**
 * zod at the trust boundary: vendor responses and webhook payloads are parsed
 * into the minimal shapes a connector relies on. Unknown fields are ignored.
 */
import type { z } from "zod";
import { ConnectorError } from "../types.js";

export function parseAs<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    throw new ConnectorError(`${what}: unexpected response shape at ${where}: ${issue?.message}`, "upstream");
  }
  return r.data;
}

/** JSON.parse that returns undefined instead of throwing (webhook bodies). */
export function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
