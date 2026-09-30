import { randomUUID } from "node:crypto";
import { MANIFEST_PATH, type Manifest, RESULT_PATH, RUNNER_COMMAND, sandboxResultSchema } from "../manifest.js";
import { costMicros } from "../pricing.js";
import { type AgentJob, type JobOutput, OUTPUT_SCHEMAS } from "../run.js";
import type { AgentKind, AgentRunResult, ModelProvider, ModelUsage, RunBounds } from "../types.js";
import { createLimiter } from "./limiter.js";
import { SandboxCommandTimeoutError, type SandboxFactory, type SandboxHandle } from "./sandbox.js";

export const PROVIDER_HOSTS: Record<Exclude<ModelProvider, "mock" | "ollama">, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/** `name:<build id>` where the build id is the immutable UUID E2B returns from a build. Mutable tags are refused. */
const PINNED_TEMPLATE = /^([a-z0-9][a-z0-9-_/]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parsePinnedTemplate(ref: string): { name: string; buildId: string } {
  const m = PINNED_TEMPLATE.exec(ref);
  if (!m) {
    throw new Error(
      `E2B template "${ref}" is not pinned. Use "<name>:<buildId>" with the immutable build id printed by sandbox/build.ts, never a tag.`,
    );
  }
  return { name: m[1]!, buildId: m[2]! };
}

export interface E2bRuntimeOptions {
  factory: SandboxFactory;
  template: string;
  provider: ModelProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /**
   * "egress" (default): the E2B egress proxy sets the auth header on requests
   * to the provider host, so no key enters the guest. "env": the key is passed
   * as an env var of the runner process only (see sandbox/build.ts).
   */
  keyInjection?: "egress" | "env";
  /** Max sandboxes in flight; further runs queue. Default 20. */
  concurrency?: number;
  /** Extra seconds of sandbox lifetime beyond the wall-time bound, as a kill backstop. */
  lifetimeGraceMs?: number;
  now?: () => number;
}

interface Keyed {
  provider: "anthropic" | "openai";
  key: string;
}

export function createE2bExecutor(opts: E2bRuntimeOptions) {
  const { buildId } = parsePinnedTemplate(opts.template);
  const now = opts.now ?? Date.now;
  const limiter = createLimiter(opts.concurrency ?? 20);
  const mode = opts.keyInjection ?? "egress";

  const keyed: Keyed[] = [];
  if (opts.anthropicApiKey) keyed.push({ provider: "anthropic", key: opts.anthropicApiKey });
  if (opts.openaiApiKey) keyed.push({ provider: "openai", key: opts.openaiApiKey });
  const primary = opts.provider === "mock" ? null : keyed.find((k) => k.provider === opts.provider);
  if (opts.provider !== "mock" && !primary) throw new Error(`no API key for provider ${opts.provider}`);
  const fallback = opts.provider === "mock" ? null : (keyed.find((k) => k.provider !== opts.provider) ?? null);
  const used = [primary, fallback].filter((k): k is Keyed => k !== null);

  const egress: { allowHosts: string[]; injectHeaders: Record<string, Record<string, string>> } = {
    allowHosts: used.map((k) => PROVIDER_HOSTS[k.provider]),
    injectHeaders:
      mode === "egress"
        ? Object.fromEntries(
            used.map((k): [string, Record<string, string>] => [
              PROVIDER_HOSTS[k.provider],
              k.provider === "anthropic" ? { "x-api-key": k.key } : { authorization: `Bearer ${k.key}` },
            ]),
          )
        : {},
  };
  const runnerEnvs: Record<string, string> =
    mode === "env"
      ? Object.fromEntries(
          used.map((k) => [k.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY", k.key]),
        )
      : {};

  async function execute<K extends AgentKind>(
    job: Extract<AgentJob, { kind: K }>,
    bounds: RunBounds,
  ): Promise<AgentRunResult<JobOutput[K]>> {
    const runId = randomUUID();
    const manifest: Manifest = Object.freeze({
      version: 1 as const,
      runId,
      job: job as Manifest["job"],
      bounds,
      provider: opts.provider,
      fallbackProvider: fallback?.provider ?? null,
      auth: mode,
    });

    const started = now();
    let handle: SandboxHandle | null = null;
    let createdAt: number | null = null;
    let killedAt: number | null = null;
    let finished = false;
    let usage: ModelUsage[] = [];

    const kill = async (h: SandboxHandle) => {
      try {
        await h.kill();
      } catch {
        // The sandbox lifetime (timeoutMs) is the backstop.
      } finally {
        killedAt = now();
      }
    };

    const metering = () => ({
      usage,
      sandbox: handle
        ? {
            id: handle.id,
            templateBuild: buildId,
            seconds: Math.max(0, ((killedAt ?? now()) - (createdAt ?? started)) / 1000),
          }
        : null,
      wallMs: now() - started,
    });
    const fail = (
      error: "invalid_output" | "bound_exceeded" | "provider_error" | "sandbox_error",
      message: string,
    ) => ({ ok: false as const, error, message, metering: metering() });

    const work = async (): Promise<AgentRunResult<JobOutput[K]>> => {
      // E2B bills from the create request, so sandbox seconds start here.
      createdAt = now();
      const creating = opts.factory.create({
        template: opts.template,
        timeoutMs: bounds.maxWallMs + (opts.lifetimeGraceMs ?? 30_000),
        metadata: { runId, kind: job.kind },
        egress,
      });
      // If the run already timed out when creation completes, kill immediately.
      const h = await creating;
      handle = h;
      if (finished) {
        await kill(h);
        throw new Error("run finished before the sandbox was ready");
      }
      await h.writeFile(MANIFEST_PATH, JSON.stringify(manifest));
      const remaining = bounds.maxWallMs - (now() - started);
      if (remaining <= 0) return fail("bound_exceeded", `wall time exceeded (${bounds.maxWallMs}ms)`);
      let outcome: Awaited<ReturnType<SandboxHandle["run"]>>;
      try {
        outcome = await h.run(RUNNER_COMMAND, { timeoutMs: remaining, envs: runnerEnvs });
      } catch (e) {
        if (e instanceof SandboxCommandTimeoutError)
          return fail("bound_exceeded", `wall time exceeded (${bounds.maxWallMs}ms)`);
        throw e;
      }
      if (outcome.exitCode !== 0) return fail("sandbox_error", `runner exited with code ${outcome.exitCode}`);

      let raw: unknown;
      try {
        raw = JSON.parse(await h.readFile(RESULT_PATH));
      } catch (e) {
        return fail("sandbox_error", `unreadable result: ${(e as Error).message}`);
      }
      const parsed = sandboxResultSchema.safeParse(raw);
      if (!parsed.success) return fail("sandbox_error", `result failed validation: ${parsed.error.message}`);
      const result = parsed.data;
      // Meter from reported tokens but price on the host: the guest's cost figure is not trusted.
      usage = result.usage.map((u) => ({ ...u, costMicros: costMicros(u.model, u) }));

      // Host-side bound checks: a bound hit is a failed run, never a partial success.
      const outTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
      if (now() - started > bounds.maxWallMs)
        return fail("bound_exceeded", `wall time exceeded (${bounds.maxWallMs}ms)`);
      if (result.modelCalls > bounds.maxModelCalls) {
        return fail("bound_exceeded", `model calls ${result.modelCalls} > ${bounds.maxModelCalls}`);
      }
      if (outTokens > bounds.maxOutputTokens) {
        return fail("bound_exceeded", `output tokens ${outTokens} > ${bounds.maxOutputTokens}`);
      }
      if (!result.ok) return fail(result.error, result.message);

      const output = OUTPUT_SCHEMAS[job.kind].safeParse(result.output);
      if (!output.success) return fail("invalid_output", `sandbox output failed validation: ${output.error.message}`);
      return { ok: true, output: output.data as JobOutput[K], metering: metering() };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AgentRunResult<JobOutput[K]>>((resolve) => {
      timer = setTimeout(
        () => resolve(fail("bound_exceeded", `wall time exceeded (${bounds.maxWallMs}ms)`)),
        bounds.maxWallMs,
      );
    });
    let result: AgentRunResult<JobOutput[K]>;
    const working = work();
    working.catch(() => {}); // A late failure after a timeout must not become an unhandled rejection.
    try {
      result = await Promise.race([working, timeout]);
    } catch (e) {
      result = fail("sandbox_error", (e as Error).message);
    } finally {
      clearTimeout(timer);
      finished = true;
      if (handle) await kill(handle);
    }
    // Recompute metering now that the sandbox is dead so seconds cover its whole life.
    return { ...result, metering: metering() };
  }

  return {
    run<K extends AgentKind>(job: Extract<AgentJob, { kind: K }>, bounds: RunBounds) {
      return limiter.run(() => execute(job, bounds));
    },
    limiter,
  };
}
