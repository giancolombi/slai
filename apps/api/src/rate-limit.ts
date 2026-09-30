/**
 * In-memory token buckets. Per process, so limits are per API instance; move to
 * Postgres or Redis when running more than one instance.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    /** Burst size. */
    private readonly capacity: number,
    /** Tokens restored per second. */
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  /** Takes one token for `key`; false when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSecond);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return ok;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export interface RateLimits {
  loginByIp: TokenBucket;
  loginByEmail: TokenBucket;
  webhook: TokenBucket;
}

export function defaultRateLimits(): RateLimits {
  return {
    // 20 attempts burst per IP, then 1 every 6s.
    loginByIp: new TokenBucket(20, 1 / 6),
    // 5 attempts burst per email, then 1 per minute.
    loginByEmail: new TokenBucket(5, 1 / 60),
    // 300 deliveries burst per connection, then 20/s.
    webhook: new TokenBucket(300, 20),
  };
}
