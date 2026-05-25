// Decorrelated jitter (AWS "Exponential Backoff and Jitter").
// next = min(cap, random_between(base, prev * 3)). Spreads retries to a dead
// endpoint so they don't synchronize into a thundering herd.
// See packages/api/src/do/CLAUDE.md — Invariant 1.

const BASE_MS = 1_000;       // 1s floor
const CAP_MS = 3_600_000;    // 1h ceiling

// `previousDelayMs` is the actual delay used last time (the stateful part of
// decorrelated jitter); null on the first retry, where we seed from BASE_MS.
// `rng` is injectable so tests can seed it; defaults to Math.random.
export function computeBackoff(
  previousDelayMs: number | null,
  rng: () => number = Math.random,
): number {
  const lower = BASE_MS;
  const upper = Math.max(BASE_MS, (previousDelayMs ?? BASE_MS) * 3);
  const delay = lower + rng() * (upper - lower);
  return Math.min(CAP_MS, delay);
}
