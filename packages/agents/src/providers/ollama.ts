import type { ModelUsage } from "../types.js";
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
 * A local open model served by Ollama (https://github.com/ollama/ollama/blob/main/docs/api.md).
 * Free and private: nothing leaves the machine. For prototypes and local
 * development only; production refuses MODEL_PROVIDER=ollama.
 *
 * Structured output uses Ollama's `format` (a JSON schema) with temperature 0;
 * every response is still re-validated with the zod schema, like other providers.
 * Local models cannot read PDFs, so PDF parts are dropped: the extraction prompt
 * always carries the documents' extracted text as well.
 */
export interface OllamaOptions {
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama" as const;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({
        role: m.role,
        content: m.content
          .filter((p) => p.type === "text")
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n\n"),
      })),
    ];
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          stream: false,
          think: false,
          format: toStrictJsonSchema(req.schema),
          options: { temperature: 0, num_predict: req.maxOutputTokens, num_ctx: 32_768 },
        }),
        signal: req.signal,
      });
    } catch (err) {
      throw new ProviderError(
        `ollama unreachable at ${this.opts.baseUrl} (is \`ollama serve\` running?): ${(err as Error).message}`,
        "ollama",
        null,
        true,
      );
    }
    const body = (await res.json().catch(() => ({}))) as OllamaChatResponse;
    if (!res.ok) {
      throw new ProviderError(
        `ollama ${res.status}: ${body.error ?? res.statusText}`,
        "ollama",
        res.status,
        isRetryableStatus(res.status),
      );
    }
    const usage: ModelUsage[] = [
      {
        provider: "ollama",
        model: this.opts.model,
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 0,
      },
    ];
    const text = body.message?.content ?? "";
    if (body.done_reason === "length") {
      return { ok: false, reason: "truncated", issues: ["hit max output tokens"], text, usage };
    }
    return parseJsonOutput(text, req.schema, usage);
  }
}
