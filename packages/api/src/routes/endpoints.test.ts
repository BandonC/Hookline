import { describe, it, expect } from "vitest";
import { HTTPException } from "hono/http-exception";
import { parseRateConfigPatch, parseBreakerConfigPatch } from "./endpoints";

// PATCH validator for the rate-limit pair. Semantics (Q6 iii):
//   - both absent  -> returns undefined (no change)
//   - both int+bounds -> returns the pair
//   - both null -> returns null pair (clear)
//   - everything else -> 400
// Bounds: rps in [1,100], burst in [1,1000].

function expectHttp(status: number, fn: () => unknown): HTTPException {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof HTTPException)) throw new Error("expected HTTPException");
    expect(e.status).toBe(status);
    return e;
  }
  throw new Error("expected throw");
}

describe("parseRateConfigPatch", () => {
  it("returns undefined when neither field is present", () => {
    expect(parseRateConfigPatch({})).toBeUndefined();
    expect(parseRateConfigPatch({ ordered: true })).toBeUndefined();
  });

  it("accepts a valid int pair and returns it normalized", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: 10, rate_limit_burst: 20 })).toEqual({
      rateLimitRps: 10,
      rateLimitBurst: 20,
    });
  });

  it("accepts both-null as an explicit clear", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: null, rate_limit_burst: null })).toEqual({
      rateLimitRps: null,
      rateLimitBurst: null,
    });
  });

  it("rejects half-pair (one field present, the other absent)", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 10 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_burst: 20 }));
  });

  it("rejects mixed null + int (can't clear half the pair)", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 10, rate_limit_burst: null }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: null, rate_limit_burst: 20 }));
  });

  it("rejects rps out of [1, 100]", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 0, rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 101, rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: -1, rate_limit_burst: 1 }));
  });

  it("rejects burst out of [1, 1000]", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 0 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 1001 }));
  });

  it("rejects non-integer numeric values", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1.5, rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 1.5 }));
  });

  it("rejects non-numeric types (string/boolean/etc)", () => {
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: "10", rate_limit_burst: 1 }));
    expectHttp(400, () => parseRateConfigPatch({ rate_limit_rps: true, rate_limit_burst: 1 }));
  });

  it("accepts the boundary values", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: 1, rate_limit_burst: 1 })).toEqual({
      rateLimitRps: 1,
      rateLimitBurst: 1,
    });
    expect(parseRateConfigPatch({ rate_limit_rps: 100, rate_limit_burst: 1000 })).toEqual({
      rateLimitRps: 100,
      rateLimitBurst: 1000,
    });
  });

  it("permits the documented-silly `burst < rps` (no cross-field constraint)", () => {
    expect(parseRateConfigPatch({ rate_limit_rps: 10, rate_limit_burst: 1 })).toEqual({
      rateLimitRps: 10,
      rateLimitBurst: 1,
    });
  });
});

// PATCH validator for the breaker triplet. Each field is independent and
// optional (unlike the rate-limit pair). Null = clear (use code default at
// gate time). Bounds: open_sec [1, 3600], threshold_pct [1, 100].
describe("parseBreakerConfigPatch", () => {
  it("returns undefined when no breaker field is present", () => {
    expect(parseBreakerConfigPatch({})).toBeUndefined();
    expect(parseBreakerConfigPatch({ ordered: true, rate_limit_rps: 1 })).toBeUndefined();
  });

  it("accepts circuit_breaker_enabled alone", () => {
    expect(parseBreakerConfigPatch({ circuit_breaker_enabled: true })).toEqual({
      circuitBreakerEnabled: true,
      breakerOpenSec: undefined,
      breakerThresholdPct: undefined,
    });
    expect(parseBreakerConfigPatch({ circuit_breaker_enabled: false })).toEqual({
      circuitBreakerEnabled: false,
      breakerOpenSec: undefined,
      breakerThresholdPct: undefined,
    });
  });

  it("accepts breaker_open_sec alone (independent of enabled)", () => {
    expect(parseBreakerConfigPatch({ breaker_open_sec: 60 })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: 60,
      breakerThresholdPct: undefined,
    });
  });

  it("accepts breaker_threshold_pct alone", () => {
    expect(parseBreakerConfigPatch({ breaker_threshold_pct: 25 })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: undefined,
      breakerThresholdPct: 25,
    });
  });

  it("accepts null for the two tunables (clear → code default)", () => {
    expect(parseBreakerConfigPatch({ breaker_open_sec: null, breaker_threshold_pct: null })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: null,
      breakerThresholdPct: null,
    });
  });

  it("accepts a full triplet", () => {
    expect(
      parseBreakerConfigPatch({
        circuit_breaker_enabled: true,
        breaker_open_sec: 30,
        breaker_threshold_pct: 50,
      }),
    ).toEqual({
      circuitBreakerEnabled: true,
      breakerOpenSec: 30,
      breakerThresholdPct: 50,
    });
  });

  it("rejects non-boolean circuit_breaker_enabled", () => {
    expectHttp(400, () => parseBreakerConfigPatch({ circuit_breaker_enabled: "true" }));
    expectHttp(400, () => parseBreakerConfigPatch({ circuit_breaker_enabled: 1 }));
    expectHttp(400, () => parseBreakerConfigPatch({ circuit_breaker_enabled: null }));
  });

  it("rejects breaker_open_sec out of [1, 3600]", () => {
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_open_sec: 0 }));
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_open_sec: 3601 }));
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_open_sec: -5 }));
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_open_sec: 1.5 }));
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_open_sec: "30" }));
  });

  it("rejects breaker_threshold_pct out of [1, 100]", () => {
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_threshold_pct: 0 }));
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_threshold_pct: 101 }));
    expectHttp(400, () => parseBreakerConfigPatch({ breaker_threshold_pct: 50.5 }));
  });

  it("accepts boundary values", () => {
    expect(parseBreakerConfigPatch({ breaker_open_sec: 1 })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: 1,
      breakerThresholdPct: undefined,
    });
    expect(parseBreakerConfigPatch({ breaker_open_sec: 3600 })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: 3600,
      breakerThresholdPct: undefined,
    });
    expect(parseBreakerConfigPatch({ breaker_threshold_pct: 1 })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: undefined,
      breakerThresholdPct: 1,
    });
    expect(parseBreakerConfigPatch({ breaker_threshold_pct: 100 })).toEqual({
      circuitBreakerEnabled: undefined,
      breakerOpenSec: undefined,
      breakerThresholdPct: 100,
    });
  });
});
