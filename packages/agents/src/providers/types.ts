import type { z } from "zod";
import type { AgentKind, ModelProvider, ModelUsage } from "../types.js";

export type ContentPart = { type: "text"; text: string } | { type: "pdf"; filename: string; base64: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface GenerateRequest<T> {
  task: AgentKind;
  /** Trusted instructions. Never contains untrusted content. */
  system: string;
  /** Untrusted content lives only inside delimited data blocks in these messages. */
  messages: ChatMessage[];
  /** Name for the JSON schema (OpenAI requires one). */
  schemaName: string;
  /** Output schema; the provider's response is validated with it. */
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /**
   * The structured input the prompt was rendered from. Only the mock provider
   * reads it (to stay deterministic without parsing its own prompt).
   */
  data?: unknown;
}

export type GenerateResult<T> =
  | { ok: true; value: T; text: string; usage: ModelUsage[] }
  | {
      ok: false;
      /** `invalid`: not JSON or failed the schema. `truncated`: hit max output tokens. `refused`: safety refusal. */
      reason: "invalid" | "truncated" | "refused";
      issues: string[];
      text: string;
      usage: ModelUsage[];
    };

export interface LlmProvider {
  readonly name: ModelProvider;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/** A provider-side failure (network, 4xx/5xx). `retryable` for 408/409/429/5xx and connection errors. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ModelProvider,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly usage: ModelUsage[] = [],
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isRetryableStatus(status: number | null | undefined): boolean {
  if (status == null) return true; // connection error / timeout without a status
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
