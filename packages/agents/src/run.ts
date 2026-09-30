import { z } from "zod";
import { draftReply } from "./agents/draft.js";
import { extractContract } from "./agents/extract.js";
import { triage } from "./agents/triage.js";
import { BoundExceededError, Budget, InvalidOutputError } from "./budget.js";
import { type LlmProvider, ProviderError } from "./providers/types.js";
import { contractExtractionSchema, draftReplyResultSchema, triageResultSchema } from "./schemas.js";
import type {
  AgentKind,
  AgentRunResult,
  ContractDocument,
  ContractExtraction,
  DraftReplyResult,
  RunBounds,
  TicketContext,
  TriageResult,
} from "./types.js";

export type AgentJob =
  | { kind: "contract_extraction"; input: { docs: ContractDocument[] } }
  | { kind: "triage"; input: { ctx: TicketContext } }
  | { kind: "draft_reply"; input: { ctx: TicketContext; triage: TriageResult | null } };

export type JobOutput = {
  contract_extraction: ContractExtraction;
  triage: TriageResult;
  draft_reply: DraftReplyResult;
};

/** Defaults follow docs/research/PRICING.md: a 3-minute ceiling, and one repair/retry call. */
export const DEFAULT_BOUNDS: Record<AgentKind, RunBounds> = {
  contract_extraction: { maxWallMs: 180_000, maxOutputTokens: 64_000, maxModelCalls: 2 },
  triage: { maxWallMs: 60_000, maxOutputTokens: 4_000, maxModelCalls: 2 },
  draft_reply: { maxWallMs: 120_000, maxOutputTokens: 16_000, maxModelCalls: 2 },
};

export const runBoundsSchema = z.object({
  maxWallMs: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
});

export function resolveBounds(kind: AgentKind, partial?: Partial<RunBounds>): RunBounds {
  return runBoundsSchema.parse({ ...DEFAULT_BOUNDS[kind], ...stripUndefined(partial ?? {}) });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Worker-side validators for each agent's output (used again on sandbox results). */
export const OUTPUT_SCHEMAS: Record<AgentKind, z.ZodType> = {
  contract_extraction: contractExtractionSchema,
  triage: triageResultSchema,
  draft_reply: draftReplyResultSchema,
};

async function dispatch(job: AgentJob, budget: Budget): Promise<unknown> {
  switch (job.kind) {
    case "contract_extraction":
      return extractContract(job.input.docs, budget);
    case "triage":
      return triage(job.input.ctx, budget);
    case "draft_reply":
      return draftReply(job.input.ctx, job.input.triage, budget);
  }
}

/**
 * Runs one agent job in-process under its bounds. Used by the local runtime
 * and by the sandbox runner, so both execute identical code.
 */
export async function runJob<K extends AgentKind>(
  job: Extract<AgentJob, { kind: K }>,
  bounds: RunBounds,
  provider: LlmProvider,
  now: () => number = Date.now,
): Promise<AgentRunResult<JobOutput[K]>> {
  const started = now();
  const controller = new AbortController();
  const budget = new Budget(provider, bounds, controller.signal);
  const metering = () => ({ usage: [...budget.usage], sandbox: null, wallMs: now() - started });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BoundExceededError(`wall time exceeded (${bounds.maxWallMs}ms)`));
    }, bounds.maxWallMs);
  });
  try {
    const output = await Promise.race([dispatch(job, budget), timeout]);
    const checked = OUTPUT_SCHEMAS[job.kind].safeParse(output);
    if (!checked.success) {
      return { ok: false, error: "invalid_output", message: checked.error.message, metering: metering() };
    }
    return { ok: true, output: output as JobOutput[K], metering: metering() };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (e instanceof BoundExceededError) return { ok: false, error: "bound_exceeded", message, metering: metering() };
    if (e instanceof InvalidOutputError) return { ok: false, error: "invalid_output", message, metering: metering() };
    if (e instanceof ProviderError) return { ok: false, error: "provider_error", message, metering: metering() };
    // Anything else (e.g. an unreadable document) has no closer category in the contract.
    return { ok: false, error: "provider_error", message: `agent error: ${message}`, metering: metering() };
  } finally {
    clearTimeout(timer);
  }
}
