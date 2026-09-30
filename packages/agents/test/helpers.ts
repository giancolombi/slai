import { readFileSync } from "node:fs";
import { usage } from "../src/pricing.js";
import type { GenerateRequest, GenerateResult, LlmProvider } from "../src/providers/types.js";
import type { ContractDocument, ModelUsage, TicketContext, TriageResult } from "../src/types.js";

export function fixture(filename: string, mediaType: ContractDocument["mediaType"]): ContractDocument {
  return {
    filename,
    mediaType,
    base64: readFileSync(new URL(`./fixtures/${filename}`, import.meta.url)).toString("base64"),
  };
}

export function textDoc(filename: string, text: string): ContractDocument {
  return { filename, mediaType: "text/plain", base64: Buffer.from(text).toString("base64") };
}

export function ticket(overrides: Partial<TicketContext> = {}): TicketContext {
  return {
    ticketKey: "ZD-4821",
    subject: "Export to CSV fails with an error",
    priority: "normal",
    status: "open",
    customerName: "Acme Logistics LLC",
    thread: [
      {
        at: "2026-09-28T14:02:00.000Z",
        authorRole: "requester",
        authorName: "Dana Whitfield",
        public: true,
        body: "Hi, when I export the shipments report to CSV I get an error 'Export failed'. How do I fix the export?",
      },
    ],
    sla: {
      risk: "warning",
      mostUrgent: {
        metric: "first_response",
        remainingMs: 3_600_000,
        dueAt: new Date("2026-09-28T16:02:00Z"),
        state: "running",
      },
      metrics: ["first_response", "resolution"],
    },
    knowledge: [
      {
        title: "Fixing CSV export errors",
        url: "https://help.brightline.example/articles/csv-export",
        body: "CSV export fails when a report has more than 50,000 rows; apply a date filter to export in smaller batches. Exports over the limit are rejected.",
      },
    ],
    assignees: [
      { sourceId: "grp-billing", name: "Billing", skills: ["billing"] },
      { sourceId: "grp-tier2", name: "Tier 2", skills: ["bug", "outage"] },
    ],
    ...overrides,
  };
}

export const okTriage: TriageResult = {
  summary: "Customer cannot export a report to CSV.",
  category: "bug",
  suggestedPriority: "normal",
  priorityReason: "One workflow affected.",
  suggestedAssigneeSourceId: "grp-tier2",
  sentiment: "neutral",
  needsHuman: false,
  needsHumanReason: null,
  confidence: 0.85,
};

export function fakeUsage(outputTokens = 100, model = "claude-haiku-4-5"): ModelUsage[] {
  return [usage("anthropic", model, { inputTokens: 1000, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })];
}

type Step = (req: GenerateRequest<unknown>) => GenerateResult<unknown> | Promise<GenerateResult<unknown>>;

/** A provider that replays scripted answers and records every request. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  readonly requests: GenerateRequest<unknown>[] = [];
  constructor(private readonly steps: Step[]) {}
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.requests.push(req as GenerateRequest<unknown>);
    const step = this.steps[Math.min(this.requests.length - 1, this.steps.length - 1)]!;
    return (await step(req as GenerateRequest<unknown>)) as GenerateResult<T>;
  }
}

/** Answers with `value` validated by the request's own schema, like a real provider. */
export function answer(value: unknown, outputTokens = 100): Step {
  return (req) => {
    const parsed = req.schema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data, text: JSON.stringify(value), usage: fakeUsage(outputTokens) }
      : {
          ok: false,
          reason: "invalid",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          text: JSON.stringify(value),
          usage: fakeUsage(outputTokens),
        };
  };
}
