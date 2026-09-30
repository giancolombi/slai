import type { AgentRuntime, ModelProvider } from "./types.js";

export interface AgentRuntimeConfig {
  /** "local" runs agents in-process; "e2b" runs each run in a disposable sandbox. */
  runtime: "local" | "e2b";
  provider: ModelProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  e2bApiKey?: string;
  e2bTemplate?: string;
}

/** Stub: the agents workstream implements this. */
export function createAgentRuntime(_config: AgentRuntimeConfig): AgentRuntime {
  throw new Error("agent runtime not implemented yet");
}
