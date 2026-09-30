import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
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
 * OpenAI routing (https://developers.openai.com/api/docs/models, checked 2026-09-29):
 * luna for cheap classification, 6.1-sol for drafting, astra (flagship) for extraction.
 */
export const OPENAI_MODELS: Record<AgentKind, { model: string; effort: "low" | "medium" | "high" }> = {
  triage: { model: "gpt-6-luna", effort: "low" },
  draft_reply: { model: "gpt-6.1-sol", effort: "medium" },
  contract_extraction: { model: "gpt-6-astra", effort: "high" },
};

export interface OpenAILike {
  responses: {
    create(body: ResponseCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<Response>;
  };
}

export function createOpenAIClient(apiKey: string, baseURL?: string): OpenAILike {
  return new OpenAI({ apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
}

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  constructor(private readonly client: OpenAILike) {}

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const route = OPENAI_MODELS[req.task];
    const input: ResponseInputItem[] = req.messages.map((m) =>
      m.role === "user"
        ? {
            role: "user",
            content: m.content.map((p) =>
              p.type === "text"
                ? { type: "input_text" as const, text: p.text }
                : {
                    type: "input_file" as const,
                    filename: p.filename,
                    file_data: `data:application/pdf;base64,${p.base64}`,
                  },
            ),
          }
        : { role: "assistant", content: m.content.map((p) => (p.type === "text" ? p.text : "")).join("") },
    );
    const body: ResponseCreateParamsNonStreaming = {
      model: route.model,
      instructions: req.system,
      input,
      max_output_tokens: req.maxOutputTokens,
      reasoning: { effort: route.effort },
      store: false,
      text: {
        format: { type: "json_schema", name: req.schemaName, schema: toStrictJsonSchema(req.schema), strict: true },
      },
    };

    let res: Response;
    try {
      res = await this.client.responses.create(body, req.signal ? { signal: req.signal } : undefined);
    } catch (e) {
      throw toProviderError(e);
    }

    const metered = meter(res, route.model);
    const refusal = res.output.some(
      (o) => o.type === "message" && o.content.some((c) => (c as { type: string }).type === "refusal"),
    );
    if (refusal) return { ok: false, reason: "refused", issues: ["model refused"], text: "", usage: metered };
    const text = res.output_text ?? "";
    if (res.status === "incomplete") {
      const reason = res.incomplete_details?.reason === "max_output_tokens" ? "truncated" : "invalid";
      return {
        ok: false,
        reason,
        issues: [`incomplete: ${res.incomplete_details?.reason ?? "unknown"}`],
        text,
        usage: metered,
      };
    }
    return parseJsonOutput(text, req.schema, metered);
  }
}

/** OpenAI's input_tokens includes cached tokens; we split them so each is priced once. */
export function meter(res: Response, requestedModel: string): ModelUsage[] {
  const u = res.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const model = OPENAI_PRICED.has(res.model) ? res.model : requestedModel;
  return [
    usage("openai", model, {
      inputTokens: (u?.input_tokens ?? 0) - cached,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    }),
  ];
}

const OPENAI_PRICED = new Set(Object.values(OPENAI_MODELS).map((r) => r.model));

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof OpenAI.APIUserAbortError) return new ProviderError("request aborted", "openai", null, false);
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : null;
  return new ProviderError(
    `openai ${status ?? "connection"} error: ${(e as Error)?.message ?? String(e)}`,
    "openai",
    status,
    isRetryableStatus(status),
  );
}
