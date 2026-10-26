import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../platform/errors';

/**
 * In-process token-bucket rate limiter.
 *
 * Deliberately dependency-free and honest about its limitation: state is per-process, so
 * a multi-instance deployment needs a shared store (Redis) or a gateway-level limit.
 * That trade-off is documented rather than hidden; for a single-node agency deployment
 * this is sufficient and it protects the auth and public-approval endpoints today.
 */
interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  /** Bucket key prefix, e.g. 'login'. */
  scope: string;
  /** Bucket capacity (burst). */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
  /** Key derivation. Defaults to authenticated user, else IP. */
  keyFn?: (req: Request) => string;
  message?: string;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

export function rateLimit(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key =
      opts.keyFn?.(req) ??
      (req.auth?.userId ? `u:${req.auth.userId}` : `ip:${req.ip ?? 'unknown'}`);
    const bucketKey = `${opts.scope}:${key}`;
    const now = Date.now();

    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      // Bound memory: drop the whole map if it grows unreasonably (better than OOM).
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
      bucket = { tokens: opts.capacity, updatedAt: now };
      buckets.set(bucketKey, bucket);
    } else {
      const elapsed = (now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(opts.capacity, bucket.tokens + elapsed * opts.refillPerSecond);
      bucket.updatedAt = now;
    }

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / opts.refillPerSecond);
      res.setHeader('Retry-After', String(retryAfter));
      next(
        new AppError('RATE_LIMITED', opts.message ?? `Too many requests. Try again in ${retryAfter} second(s).`, {
          expose: true,
        }),
      );
      return;
    }

    bucket.tokens -= 1;
    next();
  };
}

/** Test helper: reset limiter state between cases. */
export function resetRateLimits(): void {
  buckets.clear();
}
