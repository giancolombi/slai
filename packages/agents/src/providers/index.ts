import type { ModelProvider } from "../types.js";
import { type AnthropicLike, AnthropicProvider, createAnthropicClient } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { createOpenAIClient, type OpenAILike, OpenAIProvider } from "./openai.js";
import { DEFAULT_RETRY, FallbackProvider, RetryingProvider, type RetryOptions } from "./resilient.js";
import type { LlmProvider } from "./types.js";

export interface ProviderConfig {
  provider: ModelProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Injected SDK clients (tests, or a sandbox with egress header injection). */
  anthropicClient?: AnthropicLike;
  openaiClient?: OpenAILike;
  retry?: RetryOptions;
}

/**
 * Builds the provider chain: the primary with retries, then (if the other
 * vendor has a key) that vendor with retries as a fallback on provider errors.
 */
export function createProvider(cfg: ProviderConfig): LlmProvider {
  if (cfg.provider === "mock") return new MockProvider();
  const retry = cfg.retry ?? DEFAULT_RETRY;
  const anthropic =
    cfg.anthropicClient || cfg.anthropicApiKey
      ? new RetryingProvider(
          new AnthropicProvider(cfg.anthropicClient ?? createAnthropicClient(cfg.anthropicApiKey!)),
          retry,
        )
      : null;
  const openai =
    cfg.openaiClient || cfg.openaiApiKey
      ? new RetryingProvider(new OpenAIProvider(cfg.openaiClient ?? createOpenAIClient(cfg.openaiApiKey!)), retry)
      : null;
  const [primary, secondary] = cfg.provider === "anthropic" ? [anthropic, openai] : [openai, anthropic];
  if (!primary) throw new Error(`MODEL_PROVIDER=${cfg.provider} but no ${cfg.provider} API key is configured`);
  return secondary ? new FallbackProvider(primary, secondary) : primary;
}

export type { LlmProvider };
export { AnthropicProvider, MockProvider, OpenAIProvider };
