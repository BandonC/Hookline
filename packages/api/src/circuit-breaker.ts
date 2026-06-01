// Stateless failure-rate math for the per-endpoint circuit breaker.
// The breaker's runtime state (closed/open/half_open + open_until) lives on
// endpoints in D1 — see packages/db/src/schema.ts. The transition decision
// reads the recent delivery_attempts window for this endpoint and asks: did
// enough recent attempts fail to trip? That decision is what this file
// computes. No I/O here; all the SQL lives in endpoint-do.ts.
//
// Why stateless replay for the rate, but stateful storage for the state:
// failure rate is a pure function of the attempt history (same shape as the
// rate-limit bucket). But `open_until` is a wall-clock timer and the
// half-open trial slot is a shared decision across the bare DO + K sub-DOs
// — neither can be reconstructed from attempts alone. So we replay what we
// can, and persist what we must.

// Code constants. The two tunables the operator can override per-endpoint
// (breaker_open_sec, breaker_threshold_pct) live on the endpoint row;
// these two stay in code on purpose — they're algorithm-internal, and
// exposing them in the API would invite tuning the wrong knobs first.
// If they need to become per-endpoint later, that's a nullable column +
// PATCH branch, no breaking change.
export const BREAKER_WINDOW_MS = 30_000;
export const BREAKER_MIN_SAMPLES = 5;

// Defaults applied when the endpoint row has null for the corresponding
// tunable (operator never set them). Bounds for these live at the PATCH
// route; this module is the consumer.
export const BREAKER_OPEN_SEC_DEFAULT = 30;
export const BREAKER_THRESHOLD_PCT_DEFAULT = 50;

// One attempt sample: was it a non-2xx (or no status at all)?
// success === false means "this counted as a failure" for breaker purposes.
export type AttemptSample = { attemptedAt: number; success: boolean };

// Compute the failure rate (0..1) and sample count over the rolling window
// ending at `now`. Pure: feed it the attempts, get the answer. Attempts
// outside the window are ignored; caller may pre-filter the SQL query but
// doesn't have to.
export function failureRate(
  samples: AttemptSample[],
  windowMs: number,
  now: number,
): { rate: number; count: number; failures: number } {
  const cutoff = now - windowMs;
  let count = 0;
  let failures = 0;
  for (const s of samples) {
    if (s.attemptedAt < cutoff) continue;
    count += 1;
    if (!s.success) failures += 1;
  }
  if (count === 0) return { rate: 0, count: 0, failures: 0 };
  return { rate: failures / count, count, failures };
}

// Should the breaker trip from `closed` to `open`? Requires both:
//   - at least `minSamples` attempts in the window (don't trip on low-traffic
//     noise; a single failure on a quiet endpoint mustn't open the breaker)
//   - failure rate at or above the threshold
// Threshold is a percent integer 1..100 (matches the column on endpoints).
export function shouldTrip(
  rate: number,
  count: number,
  minSamples: number,
  thresholdPct: number,
): boolean {
  if (count < minSamples) return false;
  return rate >= thresholdPct / 100;
}

// HTTP status -> success classification, matching deliver()'s rule
// (2xx == delivered). Null means network error / timeout — counts as a
// failure for breaker purposes, same as deliver()'s scheduling decision.
export function isSuccessStatus(statusCode: number | null): boolean {
  return statusCode !== null && statusCode >= 200 && statusCode < 300;
}
