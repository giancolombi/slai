import type { ModelProvider } from "../types.js";
import { type GenerateRequest, type GenerateResult, type LlmProvider, ProviderError } from "./types.js";

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError("request aborted", "mock", null, false));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ProviderError("request aborted", "mock", null, false));
      },
      { once: true },
    );
  });

export const DEFAULT_RETRY: RetryOptions = {
  retries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: defaultSleep,
  random: Math.random,
};

/** Retries retryable ProviderErrors (429/5xx/connection) with exponential backoff and full jitter. */
export class RetryingProvider implements LlmProvider {
  readonly name: ModelProvider;
  constructor(
    private readonly inner: LlmProvider,
    private readonly opts: RetryOptions = DEFAULT_RETRY,
  ) {
    this.name = inner.name;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.generate(req);
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), this.name, null, false);
        if (!err.retryable || attempt >= this.opts.retries || req.signal?.aborted) throw err;
        const cap = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** attempt);
        await this.opts.sleep(Math.floor(this.opts.random() * cap) + 1, req.signal);
      }
    }
  }
}

/**
 * Tries `primary`; on a ProviderError (after its retries) tries `secondary`.
 * Invalid or refused output is not a provider error and does not fall back.
 */
export class FallbackProvider implements LlmProvider {
  readonly name: ModelProvider;
  constructor(
    private readonly primary: LlmProvider,
    private readonly secondary: LlmProvider,
    private readonly onFallback?: (err: ProviderError) => void,
  ) {
    this.name = primary.name;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    try {
      return await this.primary.generate(req);
    } catch (e) {
      if (!(e instanceof ProviderError) || req.signal?.aborted) throw e;
      this.onFallback?.(e);
      return this.secondary.generate(req);
    }
  }
}
