// Stateless token bucket for per-endpoint outbound rate limiting.
// The bucket holds no state of its own — its current fill is *reconstructed*
// from the recent attempt history in `delivery_attempts`. That keeps D1 the
// source of truth and survives DO eviction with zero work.
//
// Algorithm: refill at `rate` tokens/sec up to `burst`; each delivery attempt
// consumes one token. Replaying the attempts in [now - window, now] forward
// yields the current fill exactly. Anything older than `bucketWindowMs` can
// be ignored — across any quiet gap of `burst/rate` seconds the bucket
// refills to `burst`, so prior history is wiped out.
//
// Per-DO, not endpoint-wide: each sub-DO replays only attempts belonging to
// its own shard (see do/endpoint-do.ts). Effective endpoint capacity for an
// ordered endpoint is therefore K × rate (K = SHARDS_PER_ORDERED_ENDPOINT).

// Replays `attempts` (ms timestamps, sorted ascending, all in
// [now - bucketWindowMs(rate, burst), now]) to compute the bucket fill at
// `now`. Returns a fractional token count in [0, burst]. The caller decrements
// locally as it consumes tokens within an alarm tick.
export function computeTokens(
  attempts: number[],
  rate: number,
  burst: number,
  now: number,
): number {
  // Anchor at the window start: refill from the anchor is capped at `burst`,
  // so any pre-window history is correctly absorbed by the cap.
  let tokens = burst;
  let prev = now - bucketWindowMs(rate, burst);
  for (const t of attempts) {
    tokens = Math.min(burst, tokens + (rate * (t - prev)) / 1000);
    tokens -= 1;
    prev = t;
  }
  tokens = Math.min(burst, tokens + (rate * (now - prev)) / 1000);
  // Clamp negative — only possible if a config change shrinks `rate`/`burst`
  // below what historical traffic implied. Recovers naturally as time passes.
  return Math.max(0, tokens);
}

// When the bucket next holds >= 1 token, in ms. Returns `now` if a token is
// already available. Pure ms math — no I/O. Caller calls this with the local
// `tokens` value after the gate decided "dry," to set the defer alarm.
export function nextTokenAvailableAt(
  tokens: number,
  rate: number,
  now: number,
): number {
  if (tokens >= 1) return now;
  return now + Math.ceil(((1 - tokens) * 1000) / rate);
}

// Look-back window for the attempts query. Any quiet gap of this length
// refills the bucket to `burst`, so older attempts cannot constrain the
// current state. Ceil so the window is never under the true refill time.
export function bucketWindowMs(rate: number, burst: number): number {
  return Math.ceil((burst * 1000) / rate);
}
