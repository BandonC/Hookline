// Token-bucket math for the per-endpoint ingestion rate limiter. Pure so it can
// be unit-tested with a fixed clock; the IngestLimiterDO (do/ingest-limiter-do.ts)
// owns persistence and the HTTP shell, the same split as backoff.ts vs the DO and
// scheduler.ts vs scheduler-do.ts.
//
// This is a *defensive* cap on ingestion volume per endpoint, not a tunable
// product feature: the threat is a compromised publisher (one holding a valid
// ingest_key) flooding its own endpoint. The endpoint id is the bucket key,
// which matches the credential boundary.

export type BucketState = { tokens: number; lastRefillMs: number };

// A fresh bucket starts full so a new endpoint isn't throttled on its first burst.
export function initialBucket(burst: number, now: number): BucketState {
  return { tokens: burst, lastRefillMs: now };
}

// Refill at `rate` tokens/sec up to `burst`, then try to spend one. Returns the
// next state regardless of outcome (the refill clock always advances). On deny,
// `retryAfterMs` is how long until one token is available.
export function consumeToken(
  state: BucketState,
  rate: number,
  burst: number,
  now: number,
): { allowed: boolean; state: BucketState; retryAfterMs: number } {
  const elapsedSec = Math.max(0, now - state.lastRefillMs) / 1000;
  const tokens = Math.min(burst, state.tokens + elapsedSec * rate);

  if (tokens >= 1) {
    return { allowed: true, state: { tokens: tokens - 1, lastRefillMs: now }, retryAfterMs: 0 };
  }
  const retryAfterMs = Math.ceil(((1 - tokens) / rate) * 1000);
  return { allowed: false, state: { tokens, lastRefillMs: now }, retryAfterMs };
}
