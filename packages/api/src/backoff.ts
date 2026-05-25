// Decorrelated jitter (AWS "Exponential Backoff and Jitter").
// next = min(cap, random_between(base, prev * 3)). Spreads retries to a dead
// endpoint so they don't synchronize into a thundering herd.
// See packages/api/src/do/CLAUDE.md — Invariant 1.

const BASE_MS = 1_000;       // 1s floor
const CAP_MS = 3_600_000;    // 1h ceiling

export function computeBackoff(previousDelayMs: number): number {
  // TODO: implement decorrelated jitter:
  //   lower = BASE_MS
  //   upper = max(BASE_MS, previousDelayMs * 3)
  //   return min(CAP_MS, lower + random * (upper - lower))
  throw new Error("computeBackoff not implemented");
}
