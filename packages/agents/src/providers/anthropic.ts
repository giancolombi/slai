import Anthropic from "@anthropic-ai/sdk";
import { usage } from "../pricing.js";
import type { AgentKind, ModelUsage } from "../types.js";
import { toStrictJsonSchema } from "./json-schema.js";
import { parseJsonOutput } from "./parse.js";
import {
  type GenerateRequest,
  type GenerateResult,
  isRetryableStatus,
  type LlmProvider,
  ProviderError,
} from "./types.js";

/**
 * Model routing (claude-api skill, model table cached 2026-09-25):
 * - triage: Haiku 4.5, fast and cheap. No `effort` (errors on Haiku 4.5), no thinking.
 * - draft_reply: Sonnet 5.5 at medium effort (adaptive thinking is on by default).
 * - contract_extraction: Opus 5.5 at high effort, native PDF input. Opus 5.5 is used
 *   rather than Fable 5.1 because Fable 5.1 is not available under zero data
 *   retention, which ADR-004 commits us to where available.
 */
export const ANTHROPIC_MODELS: Record<AgentKind, { model: string; effort: "low" | "medium" | "high" | null }> = {
  triage: { model: "claude-haiku-4-5", effort: null },
  draft_reply: { model: "claude-sonnet-5-5", effort: "medium" },
  contract_extraction: { model: "claude-opus-5-5", effort: "high" },
};

/** Beta for server-side refusal fallback (`fallbacks: "default"`), Sonnet 5.5 / Opus 5.5 only. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The one SDK surface we use, so tests can inject a fake. */
export interface AnthropicLike {
  beta: {
    messages: {
      stream(
        body: Anthropic.Beta.Messages.MessageCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): { finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage> };
    };
  };
}

export function createAnthropicClient(apiKey: string, baseURL?: string): AnthropicLike {
  // Retries are ours (withRetry) so the fallback decision sees the final outcome.
  return new Anthropic({ apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  constructor(private readonly client: AnthropicLike) {}

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const route = ANTHROPIC_MODELS[req.task];
    const serverFallback = route.model !== "claude-haiku-4-5";
    const body: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
      model: route.model,
      max_tokens: req.maxOutputTokens,
      stream: true,
      // The system prompt is identical for every run of a task: cache it.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map(
          (p): Anthropic.Beta.Messages.BetaContentBlockParam =>
            p.type === "text"
              ? { type: "text", text: p.text }
              : {
                  type: "document",
                  title: p.filename,
                  source: { type: "base64", media_type: "application/pdf", data: p.base64 },
                },
        ),
      })),
      output_config: {
        format: { type: "json_schema", schema: toStrictJsonSchema(req.schema) },
        ...(route.effort ? { effort: route.effort } : {}),
      },
      ...(serverFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await this.client.beta.messages
        .stream(body, req.signal ? { signal: req.signal } : undefined)
        .finalMessage();
    } catch (e) {
      throw toProviderError(e);
    }

    const metered = meter(msg, route.model);
    const text = msg.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (msg.stop_reason === "refusal") {
      return { ok: false, reason: "refused", issues: ["model refused"], text: "", usage: metered };
    }
    if (msg.stop_reason === "max_tokens") {
      return { ok: false, reason: "truncated", issues: ["hit max output tokens"], text, usage: metered };
    }
    return parseJsonOutput(text, req.schema, metered);
  }
}

/**
 * Per-attempt metering. With server-side fallback, `usage.iterations` is the
 * per-attempt source of truth and top-level `usage` covers only the attempt
 * that produced the message.
 */
export function meter(msg: Anthropic.Beta.Messages.BetaMessage, requestedModel: string): ModelUsage[] {
  const its = msg.usage.iterations?.filter((i) => i.type === "message" || i.type === "fallback_message") ?? [];
  if (its.length > 0) {
    return its.map((i) =>
      usage("anthropic", ("model" in i && i.model) || requestedModel, {
        inputTokens: i.input_tokens,
        outputTokens: i.output_tokens,
        cacheReadTokens: i.cache_read_input_tokens,
        cacheWriteTokens: i.cache_creation_input_tokens,
      }),
    );
  }
  return [
    usage("anthropic", msg.model || requestedModel, {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    }),
  ];
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIUserAbortError) {
    return new ProviderError("request aborted", "anthropic", null, false);
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : null;
    return new ProviderError(
      `anthropic ${status ?? "connection"} error: ${e.message}`,
      "anthropic",
      status,
      isRetryableStatus(status),
    );
  }
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : null;
  return new ProviderError(
    `anthropic error: ${(e as Error)?.message ?? String(e)}`,
    "anthropic",
    status,
    isRetryableStatus(status),
  );
}
