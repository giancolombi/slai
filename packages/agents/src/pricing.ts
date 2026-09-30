/**
 * List prices per million tokens, in USD. Because 1 USD per MTok is exactly
 * 1 micro-dollar per token, `tokens * pricePerMTok` is already micro-dollars.
 *
 * Sources (checked 2026-09-29):
 * - Anthropic: claude-api skill model table (cached 2026-09-25) and
 *   https://platform.claude.com/docs/en/about-claude/pricing. Cache reads are
 *   0.1x input (Opus 5.5 / Sonnet 5.5: $0.20 flat); 5-minute cache writes are 1.25x input.
 * - OpenAI: https://developers.openai.com/api/docs/pricing (standard tier, <=272K context).
 *   OpenAI has no cache-write surcharge.
 */
import type { ModelProvider, ModelUsage } from "./types.js";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Fallback targets the server may route a refused request to (fallbacks: "default").
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // OpenAI
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
  // Mock: free.
  mock: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export class UnknownModelPriceError extends Error {}

/** Cost of one call in integer micro-dollars. Unknown models throw: we never meter at $0 by accident. */
export function costMicros(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const p = PRICES[model];
  if (!p) throw new UnknownModelPriceError(`no price for model "${model}"`);
  return Math.round(
    u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite,
  );
}

export function usage(
  provider: ModelProvider,
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): ModelUsage {
  return { provider, model, ...u, costMicros: costMicros(model, u) };
}
