import type { Database } from "@slai/db";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context.js";
import { ApiError } from "./errors.js";

/**
 * In-memory token buckets. Per process, so limits are per API instance; with
 * more than one instance, also enable the shared Postgres store below
 * (RATE_LIMIT_STORE=postgres, TR-24a).
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

// ---------- shared store (T-63) ----------

/**
 * A rate limiter every API replica shares. The in-memory TokenBuckets above
 * are per process: with N replicas a client gets N times the budget. Set
 * RATE_LIMIT_STORE=postgres before running more than one replica (TR-24a).
 */
export interface SharedRateLimiter {
  take(key: string, capacity: number, refillPerSecond: number): Promise<boolean>;
}

/** Token buckets in the unlogged `rate_limit_buckets` table: one atomic upsert per check. */
export function postgresRateLimiter(sql: Database["client"]): SharedRateLimiter {
  return {
    async take(key, capacity, refillPerSecond) {
      const [row] = await sql<{ tokens: number }[]>`
        insert into rate_limit_buckets (key, tokens, updated_at) values (${key}, ${capacity - 1}, now())
        on conflict (key) do update set
          tokens = greatest(-1, least(${capacity}::real,
            rate_limit_buckets.tokens
              + extract(epoch from now() - rate_limit_buckets.updated_at)::real * ${refillPerSecond}::real) - 1),
          updated_at = now()
        returning tokens`;
      return (row?.tokens ?? -1) >= 0;
    },
  };
}

export interface SharedRule {
  /** The bucket key for this request, or null when the rule does not apply. */
  key(method: string, path: string, ip: string | null): string | null;
  capacity: number;
  refillPerSecond: number;
}

/**
 * The shared limits, matching the per-process defaults: sign-in, signup and
 * every other POST under /auth per IP, and webhook deliveries per connection.
 * The per-email login limit stays in process (it needs the request body).
 */
export function defaultSharedRules(apiBase: string): SharedRule[] {
  const webhook = new RegExp(`^${apiBase}/webhooks/([0-9a-f-]{36})$`);
  return [
    {
      key: (m, p, ip) => (m === "POST" && p.startsWith(`${apiBase}/auth/`) ? `auth-ip:${ip ?? "unknown"}` : null),
      capacity: 20,
      refillPerSecond: 1 / 6,
    },
    {
      key: (m, p) => {
        const id = m === "POST" ? webhook.exec(p)?.[1] : undefined;
        return id ? `webhook:${id}` : null;
      },
      capacity: 300,
      refillPerSecond: 20,
    },
  ];
}

export function sharedRateLimit(limiter: SharedRateLimiter, rules: SharedRule[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    for (const r of rules) {
      const key = r.key(c.req.method, c.req.path, c.get("ip"));
      if (key && !(await limiter.take(key, r.capacity, r.refillPerSecond))) {
        throw new ApiError(429, "rate_limited", "Too many requests. Try again shortly.");
      }
    }
    await next();
  };
}
