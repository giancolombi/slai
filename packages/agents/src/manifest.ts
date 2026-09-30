/**
 * The contract between the worker (host) and the sandbox runner. The manifest
 * is written once per run and never contains credentials; the result is
 * untrusted until the host validates it.
 */
import { z } from "zod";
import { runBoundsSchema } from "./run.js";

export const MANIFEST_PATH = "/work/manifest.json";
export const RESULT_PATH = "/work/result.json";
export const RUNNER_COMMAND = "node /opt/slai/runner.js";

/** Placeholder API key the in-sandbox SDKs send; the E2B egress proxy overwrites the auth header. */
export const EGRESS_INJECTED_KEY = "injected-at-egress";

const provider = z.enum(["anthropic", "openai", "ollama", "mock"]);

export const manifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  job: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("contract_extraction"), input: z.object({ docs: z.array(z.any()) }) }),
    z.object({ kind: z.literal("triage"), input: z.object({ ctx: z.any() }) }),
    z.object({ kind: z.literal("draft_reply"), input: z.object({ ctx: z.any(), triage: z.any().nullable() }) }),
  ]),
  bounds: runBoundsSchema,
  provider,
  /** Provider to fall back to on provider errors, if the host configured it. */
  fallbackProvider: provider.nullable(),
  /** "egress": auth headers are injected by the sandbox egress proxy. "env": keys are in the runner's env. */
  auth: z.enum(["egress", "env"]),
});
export type Manifest = z.infer<typeof manifestSchema>;

const usageSchema = z.strictObject({
  provider,
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
});

export const sandboxResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    output: z.unknown(),
    usage: z.array(usageSchema),
    modelCalls: z.number().int().nonnegative(),
    wallMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(["invalid_output", "bound_exceeded", "provider_error", "sandbox_error"]),
    message: z.string(),
    usage: z.array(usageSchema),
    modelCalls: z.number().int().nonnegative(),
    wallMs: z.number().nonnegative(),
  }),
]);
export type SandboxResult = z.infer<typeof sandboxResultSchema>;
