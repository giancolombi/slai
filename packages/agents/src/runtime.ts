import { createProvider } from "./providers/index.js";
import type { LlmProvider } from "./providers/types.js";
import { type AgentJob, type JobOutput, resolveBounds, runJob } from "./run.js";
import { createE2bExecutor } from "./runtime/e2b.js";
import { e2bSandboxFactory, type SandboxFactory } from "./runtime/sandbox.js";
import type { AgentKind, AgentRunResult, AgentRuntime, ModelProvider, RunBounds } from "./types.js";

export interface AgentRuntimeConfig {
  /** "local" runs agents in-process; "e2b" runs each run in a disposable sandbox. */
  runtime: "local" | "e2b";
  provider: ModelProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  e2bApiKey?: string;
  /** Pinned template reference `name:<buildId>` (see sandbox/build.ts). */
  e2bTemplate?: string;
  /** e2b: how provider keys reach the model API. Default "egress" (header injected outside the guest). */
  e2bKeyInjection?: "egress" | "env";
  /** e2b: max sandboxes in flight. Default 20. */
  concurrency?: number;
  /** Injected sandbox SDK (tests); defaults to the real E2B SDK. */
  sandboxFactory?: SandboxFactory;
  /** Injected model provider for the local runtime (tests). */
  llm?: LlmProvider;
}

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
  let exec: <K extends AgentKind>(
    job: Extract<AgentJob, { kind: K }>,
    bounds: RunBounds,
  ) => Promise<AgentRunResult<JobOutput[K]>>;

  if (config.runtime === "local") {
    const provider =
      config.llm ??
      createProvider({
        provider: config.provider,
        anthropicApiKey: config.anthropicApiKey,
        openaiApiKey: config.openaiApiKey,
      });
    exec = (job, bounds) => runJob(job, bounds, provider);
  } else {
    if (!config.e2bTemplate)
      throw new Error("E2B_TEMPLATE (a pinned name:<buildId>) is required for AGENT_RUNTIME=e2b");
    const factory =
      config.sandboxFactory ??
      (config.e2bApiKey
        ? e2bSandboxFactory(config.e2bApiKey)
        : (() => {
            throw new Error("E2B_API_KEY is required for AGENT_RUNTIME=e2b");
          })());
    const executor = createE2bExecutor({
      factory,
      template: config.e2bTemplate,
      provider: config.provider,
      anthropicApiKey: config.anthropicApiKey,
      openaiApiKey: config.openaiApiKey,
      keyInjection: config.e2bKeyInjection,
      concurrency: config.concurrency,
    });
    exec = (job, bounds) => executor.run(job, bounds);
  }

  return {
    extractContract: (docs, bounds) =>
      exec({ kind: "contract_extraction", input: { docs } }, resolveBounds("contract_extraction", bounds)),
    triage: (ctx, bounds) => exec({ kind: "triage", input: { ctx } }, resolveBounds("triage", bounds)),
    draftReply: (ctx, triage, bounds) =>
      exec({ kind: "draft_reply", input: { ctx, triage } }, resolveBounds("draft_reply", bounds)),
  };
}
