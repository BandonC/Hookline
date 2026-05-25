# CLAUDE.md — packages/api/src/do (the Durable Object)

This is the heart of v1 and the place where correctness is easiest to get subtly wrong.
The per-endpoint Durable Object is both the scheduler and the delivery worker. Four
project invariants live here. Read them before writing a line.

Inherits all root and `packages/api` rules. The rules below are stricter because the
failure modes are quiet — code that looks fine but corrupts delivery guarantees.

## The delivery loop (what the DO does)

1. The ingestion API (or the reconciliation cron) pokes the DO via `fetch()` with an
   event that's due. The DO sets an alarm for the soonest due time.
2. `alarm()` fires. The DO loads this endpoint's due `pending` events from D1, and for
   each calls `deliver()`.
3. `deliver()` signs, POSTs with a timeout, records the attempt, and decides: delivered →
   done; failed and under max attempts → schedule a retry; failed at max attempts →
   dead-letter.
4. After the loop, if pending events remain, `alarm()` re-arms `setAlarm()` to the next
   soonest due time.

## Invariant 1 — backoff is computed here, in code

- Retry delay is **decorrelated jitter**, in `backoff.ts`:
  `next = min(cap, random_between(base, previous_delay * 3))`.
- Base is 1s, cap is 1h. Don't change these without being asked.
- This is NOT read from any platform retry config — there is no queue. The whole point of
  owning the scheduler is that this curve is real code we can explain. Don't "simplify" it
  to a fixed multiplier or a `setTimeout` constant.
- Why decorrelated and not full/equal jitter: when many events to the same dead endpoint
  back off together, decorrelated jitter spreads them best and avoids a thundering herd on
  recovery. This rationale matters — preserve it.

## Invariant 2 — signing covers `timestamp.body`, event ID is inside the body

- `signing.ts` signs the string `` `${timestamp}.${rawBody}` `` with HMAC-SHA256 via Web
  Crypto, and returns `v1=<hex>`.
- Headers: `X-Hookline-Timestamp` and `X-Hookline-Signature`. `X-Hookline-Event-Id` may be
  sent for convenience, but it is NOT the source of authority — the event ID inside the
  signed JSON body is. Don't rely on the header for identity.
- This is the Stripe construction. Don't invent a different scheme, don't sign only the
  body (that loses replay protection), don't move signing inline into the delivery method
  (keep it in `signing.ts` so it's testable and versioned).

## Invariant 3 — record exactly one attempt, with batched writes

- Every delivery attempt writes exactly one row to `delivery_attempts` (status code,
  response snippet, latency, attempt number) — success or failure.
- The attempt-insert and the event mutation (status update, or attempt_count +
  next_attempt_at) go in a **single D1 `batch()` call** — one round trip, not two
  sequential writes. This halves write volume against D1's free-tier limit and keeps the
  two writes atomic-ish.
- If write volume ever becomes a problem under load testing, the documented scaling lever
  is to sample/aggregate attempt rows — NOT to drop attempt logging. Don't pre-build that;
  just don't design in a way that blocks it.

## Invariant 4 — bounded response read, never read-then-slice

- Read at most ~1KB (`RESPONSE_SNIPPET_CAP`) from the receiver's response body, then stop
  and cancel the stream. See the `readCapped` helper.
- Never `await res.text()` then `.slice(0, 1024)` — that buffers the entire body first,
  so a hostile endpoint streaming gigabytes can OOM the Worker before you slice. The cap
  must be enforced *during* the read.

## DO lifecycle gotchas (verify against current Workers docs — these change)

- `state.storage.setAlarm(ts)` schedules; `getAlarm()` returns the current alarm or null.
  Only one alarm per DO — when scheduling a sooner event, compare against the existing
  alarm and only move it earlier.
- `alarm()` can be retried by the platform if it throws. Make it safe to run twice: loading
  due events from D1 and re-checking status before delivering keeps it idempotent. Don't
  assume `alarm()` runs exactly once.
- The DO must remain addressable per-endpoint via `idFromName(endpointId)`. Don't store
  cross-endpoint state — v2's ordering and per-endpoint breaker assume one DO owns exactly
  one endpoint.

## Testing this folder

- `computeBackoff`: feed a sequence, assert each result is within `[base, prev*3]`, capped
  at 1h, and that the cap actually clamps. Seed randomness.
- `signPayload`: assert a known `(secret, body, timestamp)` produces a stable signature and
  that a tampered body or timestamp changes it. This is the test that proves Invariant 2.
- `deliver`: mock `fetch`, D1, and time. Assert exactly one attempt row per call, the
  batched write happens, success marks delivered, max-attempts dead-letters. Don't mock the
  DO itself — that's the thing under test.
