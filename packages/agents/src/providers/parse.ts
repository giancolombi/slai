import type { z } from "zod";
import type { ModelUsage } from "../types.js";
import type { GenerateResult } from "./types.js";

/** Model text is only ever parsed as JSON and validated with the schema; nothing else is trusted. */
export function parseJsonOutput<T>(text: string, schema: z.ZodType<T>, usage: ModelUsage[]): GenerateResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid", issues: ["output is not valid JSON"], text, usage };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", issues: formatIssues(parsed.error.issues), text, usage };
  }
  return { ok: true, value: parsed.data, text, usage };
}

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}
