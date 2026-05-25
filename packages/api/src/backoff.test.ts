import { describe, it, expect } from "vitest";
import { computeBackoff } from "./backoff";

// Mirror of the constants in backoff.ts. Asserting against literals here also
// guards Invariant 1 — if base/cap are silently changed, these fail.
const BASE = 1_000;
const CAP = 3_600_000;

// A constant "random" position in [0,1). rng(0) lands at the window floor,
// rng(1) at the ceiling. (Real Math.random is [0,1); 1 is a test convenience.)
const rng = (v: number) => () => v;

describe("computeBackoff", () => {
  it("seeds the first retry (null prev) from BASE: window is [BASE, 3*BASE]", () => {
    expect(computeBackoff(null, rng(0))).toBe(BASE);
    expect(computeBackoff(null, rng(1))).toBe(3 * BASE);
  });

  it("returns BASE at the window floor regardless of prev", () => {
    expect(computeBackoff(5_000, rng(0))).toBe(BASE);
    expect(computeBackoff(1_000_000, rng(0))).toBe(BASE);
  });

  it("keeps each delay within [BASE, prev*3]", () => {
    const prev = 5_000;
    for (const v of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = computeBackoff(prev, rng(v));
      expect(d).toBeGreaterThanOrEqual(BASE);
      expect(d).toBeLessThanOrEqual(prev * 3);
    }
  });

  it("clamps to CAP when prev*3 would overshoot it", () => {
    // prev*3 = 6,000,000 > CAP, so the ceiling must be the cap, not the window top.
    expect(computeBackoff(2_000_000, rng(1))).toBe(CAP);
    expect(computeBackoff(2_000_000, rng(0.999999))).toBeLessThanOrEqual(CAP);
  });

  it("a seeded chain stays in-bounds and capped at every step", () => {
    const rand = mulberry32(42);
    let prev: number | null = null;
    for (let i = 0; i < 30; i++) {
      const ceiling = Math.min(CAP, Math.max(BASE, (prev ?? BASE) * 3));
      const d = computeBackoff(prev, rand);
      expect(d).toBeGreaterThanOrEqual(BASE);
      expect(d).toBeLessThanOrEqual(ceiling);
      prev = d;
    }
  });
});

// Small seeded PRNG so the chain test is deterministic (no flaky tests).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
