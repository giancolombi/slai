import type { GenerateRequest, GenerateResult, LlmProvider } from "./providers/types.js";
import { ProviderError } from "./providers/types.js";
import type { ModelUsage, RunBounds } from "./types.js";

export class BoundExceededError extends Error {
  override name = "BoundExceededError";
}

export class InvalidOutputError extends Error {
  override name = "InvalidOutputError";
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(`${message}: ${issues.slice(0, 20).join("; ")}`);
  }
}

export type BudgetedRequest<T> = Omit<GenerateRequest<T>, "signal" | "maxOutputTokens"> & { maxOutputTokens?: number };

/**
 * Enforces a run's bounds around a provider and meters every call. Exceeding
 * a bound throws BoundExceededError; the run then fails as a whole.
 */
export class Budget {
  readonly usage: ModelUsage[] = [];
  calls = 0;

  constructor(
    private readonly provider: LlmProvider,
    readonly bounds: RunBounds,
    readonly signal: AbortSignal,
  ) {}

  get outputTokens(): number {
    return this.usage.reduce((n, u) => n + u.outputTokens, 0);
  }

  async generate<T>(req: BudgetedRequest<T>): Promise<GenerateResult<T>> {
    if (this.signal.aborted) throw new BoundExceededError(`wall time exceeded (${this.bounds.maxWallMs}ms)`);
    if (this.calls >= this.bounds.maxModelCalls) {
      throw new BoundExceededError(`model call limit reached (${this.bounds.maxModelCalls})`);
    }
    const remaining = this.bounds.maxOutputTokens - this.outputTokens;
    if (remaining <= 0) throw new BoundExceededError(`output token limit reached (${this.bounds.maxOutputTokens})`);
    this.calls++;
    let res: GenerateResult<T>;
    try {
      res = await this.provider.generate({
        ...req,
        maxOutputTokens: Math.min(req.maxOutputTokens ?? remaining, remaining),
        signal: this.signal,
      });
    } catch (e) {
      if (e instanceof ProviderError) this.usage.push(...e.usage);
      if (this.signal.aborted) throw new BoundExceededError(`wall time exceeded (${this.bounds.maxWallMs}ms)`);
      throw e;
    }
    this.usage.push(...res.usage);
    if (this.outputTokens > this.bounds.maxOutputTokens) {
      throw new BoundExceededError(
        `output token limit exceeded (${this.outputTokens} > ${this.bounds.maxOutputTokens})`,
      );
    }
    if (!res.ok && res.reason === "truncated") {
      throw new BoundExceededError(`output truncated at the token limit (${this.bounds.maxOutputTokens})`);
    }
    return res;
  }
}
