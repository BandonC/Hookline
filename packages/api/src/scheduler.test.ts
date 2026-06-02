// Pure scheduler logic — credit math + decision rules. No DO, no storage.
// Each test feeds explicit state in and asserts the decision; mutations are
// observed by reading state after applyGrant/applyRelease.
//
// Coverage: accrual cap, decision order (global → tenant → credits),
// grant/release counter updates. The corresponding integration story
// (alarm() actually calls the coordinator and defers events) lives in
// do/tenant-gate.integration.test.ts.

import { describe, it, expect } from "vitest";
import {
  initialTenantState,
  advanceCredits,
  decideAcquire,
  applyGrant,
  applyRelease,
} from "./scheduler";
import {
  ACCRUAL_INTERVAL_MS,
  CREDIT_CAP_PER_TENANT,
  DEFAULT_TENANT_MAX_IN_FLIGHT,
  GLOBAL_MAX_IN_FLIGHT,
} from "./tenancy";

describe("advanceCredits", () => {
  it("does nothing when no time has elapsed", () => {
    const s = initialTenantState(1000);
    advanceCredits(s, 1, 1000);
    expect(s.credits).toBe(CREDIT_CAP_PER_TENANT);
  });

  it("accrues weight credits per interval", () => {
    const s = { credits: 0, inFlight: 0, lastTouchedAt: 0 };
    advanceCredits(s, 1, ACCRUAL_INTERVAL_MS);
    expect(s.credits).toBeCloseTo(1);

    const s2 = { credits: 0, inFlight: 0, lastTouchedAt: 0 };
    advanceCredits(s2, 5, ACCRUAL_INTERVAL_MS);
    expect(s2.credits).toBeCloseTo(5);
  });

  it("caps at CREDIT_CAP_PER_TENANT no matter how long the wait", () => {
    const s = { credits: 0, inFlight: 0, lastTouchedAt: 0 };
    advanceCredits(s, 10, ACCRUAL_INTERVAL_MS * 10_000);
    expect(s.credits).toBe(CREDIT_CAP_PER_TENANT);
  });

  it("bumps lastTouchedAt to now even when no credit was added", () => {
    const s = { credits: CREDIT_CAP_PER_TENANT, inFlight: 0, lastTouchedAt: 1000 };
    advanceCredits(s, 1, 2000);
    expect(s.lastTouchedAt).toBe(2000);
    expect(s.credits).toBe(CREDIT_CAP_PER_TENANT); // already capped
  });
});

describe("decideAcquire", () => {
  const fullState = () => ({
    credits: CREDIT_CAP_PER_TENANT,
    inFlight: 0,
    lastTouchedAt: 0,
  });

  it("grants when under all caps and credits >= 1", () => {
    const d = decideAcquire(fullState(), 1, null, 0, Number.POSITIVE_INFINITY);
    expect(d.granted).toBe(true);
  });

  it("denies with global_cap when globalInFlight is at cap", () => {
    const d = decideAcquire(fullState(), 1, null, GLOBAL_MAX_IN_FLIGHT, 5000);
    expect(d).toEqual({ granted: false, retryAfterMs: 5000, reason: "global_cap" });
  });

  it("clamps global_cap retryAfter to ACCRUAL_INTERVAL_MS when no slots exist", () => {
    const d = decideAcquire(fullState(), 1, null, GLOBAL_MAX_IN_FLIGHT, Number.POSITIVE_INFINITY);
    expect(d).toEqual({ granted: false, retryAfterMs: ACCRUAL_INTERVAL_MS, reason: "global_cap" });
  });

  it("denies with tenant_cap when tenant.inFlight is at the resolved cap", () => {
    const s = { ...fullState(), inFlight: DEFAULT_TENANT_MAX_IN_FLIGHT };
    const d = decideAcquire(s, 1, null, 0, Number.POSITIVE_INFINITY);
    expect(d).toEqual({ granted: false, retryAfterMs: ACCRUAL_INTERVAL_MS, reason: "tenant_cap" });
  });

  it("uses the tenant's max_in_flight override over the code default", () => {
    const s = { ...fullState(), inFlight: 2 };
    // Override cap of 2 binds even though default (10) would allow.
    const d = decideAcquire(s, 1, 2, 0, Number.POSITIVE_INFINITY);
    expect(d.granted).toBe(false);
    if (!d.granted) expect(d.reason).toBe("tenant_cap");
  });

  it("denies with no_credits when credits < 1 and hints time-until-credit", () => {
    const s = { credits: 0.5, inFlight: 0, lastTouchedAt: 0 };
    // weight=1, need 0.5 more credit; at 1/sec that's 500ms.
    const d = decideAcquire(s, 1, null, 0, Number.POSITIVE_INFINITY);
    expect(d.granted).toBe(false);
    if (!d.granted) {
      expect(d.reason).toBe("no_credits");
      expect(d.retryAfterMs).toBe(500);
    }
  });

  it("scales no_credits retryAfter by weight (higher weight = faster recovery)", () => {
    const s = { credits: 0, inFlight: 0, lastTouchedAt: 0 };
    const d = decideAcquire(s, 4, null, 0, Number.POSITIVE_INFINITY);
    if (!d.granted) expect(d.retryAfterMs).toBe(250); // 1 / 4 * 1000
  });

  it("evaluates gates in order: global > tenant > credits", () => {
    // All three would deny — global wins.
    const s = { credits: 0, inFlight: 100, lastTouchedAt: 0 };
    const d = decideAcquire(s, 1, null, GLOBAL_MAX_IN_FLIGHT, 1234);
    if (!d.granted) expect(d.reason).toBe("global_cap");
  });
});

describe("applyGrant + applyRelease", () => {
  it("grant spends one credit and increments inFlight", () => {
    const s = { credits: 5, inFlight: 2, lastTouchedAt: 0 };
    applyGrant(s);
    expect(s.credits).toBe(4);
    expect(s.inFlight).toBe(3);
  });

  it("release decrements inFlight but never refunds credits", () => {
    const s = { credits: 5, inFlight: 3, lastTouchedAt: 0 };
    applyRelease(s);
    expect(s.credits).toBe(5);
    expect(s.inFlight).toBe(2);
  });

  it("release floors inFlight at 0 (stray release on TTL-reclaimed slot)", () => {
    const s = { credits: 5, inFlight: 0, lastTouchedAt: 0 };
    applyRelease(s);
    expect(s.inFlight).toBe(0);
  });
});
