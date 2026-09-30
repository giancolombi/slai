import type { z } from "zod";
import { isApiError } from "../../lib/api";

export type FieldErrors = Record<string, string>;

/** First message per top-level field from a zod error. */
export function zodFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_form");
    out[key] ??= issue.message;
  }
  return out;
}

/** Field errors reported by the API (`details` as zod issues), if any. */
export function apiFieldErrors(error: unknown): FieldErrors {
  if (!isApiError(error) || !Array.isArray(error.details)) return {};
  const out: FieldErrors = {};
  for (const d of error.details as { path?: (string | number)[]; message?: string }[]) {
    const key = d.path?.[0];
    if (key !== undefined && d.message) out[String(key)] ??= d.message;
  }
  return out;
}
