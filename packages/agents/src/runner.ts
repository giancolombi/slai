/**
 * The sandbox entrypoint's logic: read the manifest, run the job with the
 * same code the local runtime uses, write the result. Bundled into
 * sandbox/dist/runner.js by `pnpm build:sandbox`.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  EGRESS_INJECTED_KEY,
  MANIFEST_PATH,
  type Manifest,
  manifestSchema,
  RESULT_PATH,
  type SandboxResult,
} from "./manifest.js";
import { createProvider } from "./providers/index.js";
import type { GenerateRequest, LlmProvider } from "./providers/types.js";
import { type AgentJob, runJob } from "./run.js";

class CountingProvider implements LlmProvider {
  calls = 0;
  readonly name;
  constructor(private readonly inner: LlmProvider) {
    this.name = inner.name;
  }
  generate<T>(req: GenerateRequest<T>) {
    this.calls++;
    return this.inner.generate(req);
  }
}

function providerFor(m: Manifest, env: Record<string, string | undefined>): LlmProvider {
  const keyFor = (p: "anthropic" | "openai", envName: string): string | undefined => {
    if (m.provider !== p && m.fallbackProvider !== p) return undefined;
    return m.auth === "egress" ? EGRESS_INJECTED_KEY : env[envName];
  };
  return createProvider({
    provider: m.provider,
    anthropicApiKey: keyFor("anthropic", "ANTHROPIC_API_KEY"),
    openaiApiKey: keyFor("openai", "OPENAI_API_KEY"),
  });
}

export async function runManifest(raw: string, env: Record<string, string | undefined>): Promise<SandboxResult> {
  const started = Date.now();
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(raw));
  } catch (e) {
    return {
      ok: false,
      error: "sandbox_error",
      message: `bad manifest: ${(e as Error).message}`,
      usage: [],
      modelCalls: 0,
      wallMs: 0,
    };
  }
  const provider = new CountingProvider(providerFor(manifest, env));
  const res = await runJob(manifest.job as AgentJob, manifest.bounds, provider);
  const wallMs = Date.now() - started;
  return res.ok
    ? { ok: true, output: res.output, usage: res.metering.usage, modelCalls: provider.calls, wallMs }
    : {
        ok: false,
        error: res.error,
        message: res.message,
        usage: res.metering.usage,
        modelCalls: provider.calls,
        wallMs,
      };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const manifestPath = env.SLAI_MANIFEST_PATH ?? MANIFEST_PATH;
  const resultPath = env.SLAI_RESULT_PATH ?? RESULT_PATH;
  let result: SandboxResult;
  try {
    result = await runManifest(await readFile(manifestPath, "utf8"), env);
  } catch (e) {
    result = { ok: false, error: "sandbox_error", message: (e as Error).message, usage: [], modelCalls: 0, wallMs: 0 };
  }
  await writeFile(resultPath, JSON.stringify(result));
  return 0;
}
