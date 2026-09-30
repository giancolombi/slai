import { z } from "zod";

/**
 * Converts a zod schema into the JSON-schema subset both providers accept for
 * constrained decoding (Anthropic `output_config.format`, OpenAI strict
 * `json_schema`): every object closed and fully required, `oneOf` -> `anyOf`,
 * and value constraints (min/max/length/pattern) removed. The removed
 * constraints are still enforced: every response is re-validated with the
 * original zod schema. Model-facing schemas must therefore use `.nullable()`
 * rather than `.optional()`.
 */
const DROP = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "default",
  "format",
]);

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return clean(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as Record<string, unknown>;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    out[k === "oneOf" ? "anyOf" : k] = k === "properties" ? mapValues(v as Record<string, unknown>) : clean(v);
  }
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

function mapValues(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clean(v)]));
}
