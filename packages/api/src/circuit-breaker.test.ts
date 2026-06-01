import { describe, it, expect } from "vitest";
import {
  failureRate,
  shouldTrip,
  isSuccessStatus,
  BREAKER_WINDOW_MS,
} from "./circuit-breaker";

const NOW = 1_700_000_000_000;
const s = (n: number) => n * 1000;

describe("failureRate", () => {
  it("returns zeros when there are no samples", () => {
    expect(failureRate([], BREAKER_WINDOW_MS, NOW)).toEqual({
      rate: 0,
      count: 0,
      failures: 0,
    });
  });

  it("counts only samples inside the window", () => {
    const samples = [
      { attemptedAt: NOW - s(40), success: false }, // outside 30s window
      { attemptedAt: NOW - s(20), success: true },
      { attemptedAt: NOW - s(10), success: false },
    ];
    const r = failureRate(samples, BREAKER_WINDOW_MS, NOW);
    expect(r.count).toBe(2);
    expect(r.failures).toBe(1);
    expect(r.rate).toBe(0.5);
  });

  it("computes 100% on all failures", () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      attemptedAt: NOW - i * 100,
      success: false,
    }));
    expect(failureRate(samples, BREAKER_WINDOW_MS, NOW).rate).toBe(1);
  });

  it("computes 0% on all successes", () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      attemptedAt: NOW - i * 100,
      success: true,
    }));
    expect(failureRate(samples, BREAKER_WINDOW_MS, NOW).rate).toBe(0);
  });
});

describe("shouldTrip", () => {
  it("does not trip below the min-sample floor", () => {
    // 100% failure but only 4 samples (min is 5) -> do not trip.
    expect(shouldTrip(1, 4, 5, 50)).toBe(false);
  });

  it("trips at the threshold with enough samples", () => {
    expect(shouldTrip(0.5, 5, 5, 50)).toBe(true);
    expect(shouldTrip(0.49, 5, 5, 50)).toBe(false);
  });

  it("respects strict-vs-permissive thresholds", () => {
    // Stricter (20%) trips earlier.
    expect(shouldTrip(0.2, 10, 5, 20)).toBe(true);
    // 100% threshold requires all failures.
    expect(shouldTrip(0.9, 10, 5, 100)).toBe(false);
    expect(shouldTrip(1, 10, 5, 100)).toBe(true);
  });
});

describe("isSuccessStatus", () => {
  it("counts 2xx as success", () => {
    expect(isSuccessStatus(200)).toBe(true);
    expect(isSuccessStatus(204)).toBe(true);
    expect(isSuccessStatus(299)).toBe(true);
  });

  it("counts everything else as failure", () => {
    expect(isSuccessStatus(199)).toBe(false);
    expect(isSuccessStatus(300)).toBe(false);
    expect(isSuccessStatus(400)).toBe(false);
    expect(isSuccessStatus(500)).toBe(false);
    expect(isSuccessStatus(null)).toBe(false); // network error / timeout
  });
});
