import { describe, it, expect } from "vitest";
import { computeTokens, nextTokenAvailableAt, bucketWindowMs } from "./rate-limit";

// All times in ms. `NOW` is an arbitrary epoch chosen so deltas are easy
// to read by hand.
const NOW = 1_700_000_000_000;
const s = (n: number) => n * 1000;

describe("computeTokens", () => {
  it("returns full burst when there are no attempts", () => {
    expect(computeTokens([], 10, 10, NOW)).toBe(10);
    expect(computeTokens([], 1, 1, NOW)).toBe(1);
  });

  it("returns burst - 1 immediately after a single attempt", () => {
    expect(computeTokens([NOW], 10, 10, NOW)).toBe(9);
    expect(computeTokens([NOW], 1, 1, NOW)).toBe(0);
  });

  it("draining the full burst leaves the bucket empty", () => {
    // 10 attempts at t=NOW (rate=1, burst=10): bucket was full, all consumed.
    const attempts = Array.from({ length: 10 }, () => NOW);
    expect(computeTokens(attempts, 1, 10, NOW)).toBe(0);
  });

  it("refills at exactly `rate` tokens/sec after a drain", () => {
    // burst=10 drained at NOW-5s; rate=1; 5s later -> 5 tokens.
    const drained = Array.from({ length: 10 }, () => NOW - s(5));
    expect(computeTokens(drained, 1, 10, NOW)).toBe(5);
  });

  it("caps refill at `burst` no matter how much quiet time elapsed", () => {
    // Single attempt 1000s ago, rate=1 burst=10: refill is capped at 10.
    expect(computeTokens([NOW - s(1000)], 1, 10, NOW)).toBe(10);
  });

  it("at steady state (rate-matched traffic) leaves burst-1 tokens", () => {
    // Continuous 1/sec attempts over the window, rate=1 burst=10.
    const attempts = Array.from({ length: 11 }, (_, i) => NOW - s(10 - i));
    expect(computeTokens(attempts, 1, 10, NOW)).toBe(9);
  });

  it("burst lets multiple attempts fire at the same instant", () => {
    // rate=1 burst=5, all 5 fire at t=NOW: bucket is empty.
    const attempts = Array.from({ length: 5 }, () => NOW);
    expect(computeTokens(attempts, 1, 5, NOW)).toBe(0);
    // Doing the same with only 3 attempts leaves 2 tokens.
    const partial = Array.from({ length: 3 }, () => NOW);
    expect(computeTokens(partial, 1, 5, NOW)).toBe(2);
  });

  it("clamps negative to 0 (e.g. after a rate config tightening)", () => {
    // 20 attempts in last second; rate=1 burst=1 wouldn't have permitted them,
    // but if config shrank we still recover gracefully.
    const attempts = Array.from({ length: 20 }, (_, i) => NOW - i * 50);
    expect(computeTokens(attempts, 1, 1, NOW)).toBe(0);
  });

  it("is order-stable: equal timestamps produce the same answer regardless of count up to burst", () => {
    // Sanity: 1 attempt at NOW with burst=10 leaves 9; 2 leaves 8; etc.
    for (let k = 0; k <= 10; k++) {
      const a = Array.from({ length: k }, () => NOW);
      expect(computeTokens(a, 1, 10, NOW)).toBe(Math.max(0, 10 - k));
    }
  });
});

describe("nextTokenAvailableAt", () => {
  it("returns now when a token is already available", () => {
    expect(nextTokenAvailableAt(1, 1, NOW)).toBe(NOW);
    expect(nextTokenAvailableAt(5, 1, NOW)).toBe(NOW);
    expect(nextTokenAvailableAt(0.999999, 10, NOW)).toBe(NOW + 1); // edge
  });

  it("computes time to next whole token from fractional state", () => {
    // 0 tokens, rate=1/sec -> 1 token in 1000ms
    expect(nextTokenAvailableAt(0, 1, NOW)).toBe(NOW + 1000);
    // 0.5 tokens, rate=1/sec -> 0.5 tokens needed = 500ms
    expect(nextTokenAvailableAt(0.5, 1, NOW)).toBe(NOW + 500);
    // 0 tokens, rate=10/sec -> 100ms
    expect(nextTokenAvailableAt(0, 10, NOW)).toBe(NOW + 100);
  });
});

describe("bucketWindowMs", () => {
  it("returns burst/rate in ms, ceil'd", () => {
    expect(bucketWindowMs(1, 10)).toBe(10_000);
    expect(bucketWindowMs(10, 10)).toBe(1_000);
    expect(bucketWindowMs(3, 10)).toBe(3_334); // ceil(10000/3)
  });
});
