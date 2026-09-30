import type { ExtractionData } from "../agents/extract.js";
import { usage } from "../pricing.js";
import type { TicketContext, TriageResult } from "../types.js";
import { mockExtract } from "./mock-extract.js";
import { mockDraft, mockTriage } from "./mock-ticket.js";
import { parseJsonOutput } from "./parse.js";
import type { GenerateRequest, GenerateResult, LlmProvider } from "./types.js";

/** ~4 characters per token; deterministic, good enough for demo metering. */
const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Deterministic provider for development and demos (MODEL_PROVIDER=mock).
 * It reads the structured `data` the prompt was rendered from and applies
 * heuristics; its output goes through the same schema validation as a model's.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock" as const;

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const value = this.answer(req);
    const text = JSON.stringify(value);
    const promptChars =
      req.system.length +
      req.messages.reduce(
        (n, m) => n + m.content.reduce((k, p) => k + (p.type === "text" ? p.text.length : p.base64.length), 0),
        0,
      );
    const u = [
      usage("mock", "mock", {
        inputTokens: Math.ceil(promptChars / 4),
        outputTokens: tokens(text),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ];
    if (u[0]!.outputTokens > req.maxOutputTokens) {
      return { ok: false, reason: "truncated", issues: ["hit max output tokens"], text: "", usage: u };
    }
    return parseJsonOutput(text, req.schema, u);
  }

  private answer<T>(req: GenerateRequest<T>): unknown {
    switch (req.task) {
      case "contract_extraction":
        return mockExtract((req.data as ExtractionData).docs);
      case "triage":
        return mockTriage((req.data as { ctx: TicketContext }).ctx);
      case "draft_reply": {
        const d = req.data as { ctx: TicketContext; triage: TriageResult | null };
        return mockDraft(d.ctx, d.triage);
      }
    }
  }
}
