// Pure decision logic for the coordinator DO. The DO owns storage I/O and
// HTTP; this file owns the math. Splitting it lets every credit/slot rule be
// unit-tested with plain inputs — no Workers runtime, no DO storage harness.
//
// The contract from the design conversation:
//   - Per-tenant credits accrue lazily on each acquire (time × weight),
//     capped at CREDIT_CAP_PER_TENANT.
//   - Acquire requires globalInFlight < cap, tenant.inFlight < tenant cap,
//     and credits >= 1. A grant decrements credits and increments both
//     in-flight counters.
//   - Release decrements in-flight counters; credits are NOT refunded.

import {
  ACCRUAL_INTERVAL_MS,
  CREDIT_CAP_PER_TENANT,
  DEFAULT_TENANT_MAX_IN_FLIGHT,
  GLOBAL_MAX_IN_FLIGHT,
} from "./tenancy";

// Per-tenant credit + in-flight state held in coordinator DO storage.
// `lastTouchedAt` anchors lazy accrual; bumped on every acquire whether or
// not the call was granted, because accrual happens before the decision.
export type TenantState = {
  credits: number;
  inFlight: number;
  lastTouchedAt: number;
};

// First-touch initializer. New tenants start with a full credit cap — same as
// an idle tenant that "woke up" — so their first event isn't denied for
// lack of accrued credit. inFlight starts at 0; lastTouchedAt anchors the
// accrual clock from now.
export function initialTenantState(now: number): TenantState {
  return { credits: CREDIT_CAP_PER_TENANT, inFlight: 0, lastTouchedAt: now };
}

// Lazy time-based credit accrual. Mutates `state` in place: advances credits
// by (elapsed / interval) * weight, capped at CREDIT_CAP_PER_TENANT, and sets
// lastTouchedAt = now. Called before every acquire decision so the credit
// number reflects wall-time at the moment of the call.
export function advanceCredits(state: TenantState, weight: number, now: number): void {
  const elapsed = Math.max(0, now - state.lastTouchedAt);
  const accrued = (elapsed / ACCRUAL_INTERVAL_MS) * weight;
  state.credits = Math.min(CREDIT_CAP_PER_TENANT, state.credits + accrued);
  state.lastTouchedAt = now;
}

// The reason a deny was issued. Kept structured for logging + dashboards
// later; the per-endpoint DO uses only `retryAfterMs` operationally.
export type DenyReason = "global_cap" | "tenant_cap" | "no_credits";

export type AcquireDecision =
  | { granted: true }
  | { granted: false; retryAfterMs: number; reason: DenyReason };

// Pure decision function: given current state + the tenant's weight/cap,
// returns whether the slot is granted and (on deny) when the caller should
// retry. Does NOT mutate counters — the caller applies the grant after this
// returns. That's deliberate so the unit tests can assert decisions
// independently of side effects.
//
// Order matters: global cap binds first (defensive ceiling — protect the
// platform), then per-tenant cap (protect other tenants), then credits
// (DRR fairness). Each layer's retry hint reflects what would have to
// change for the next attempt to succeed.
export function decideAcquire(
  state: TenantState,
  weight: number,
  maxInFlight: number | null,
  globalInFlight: number,
  shortestSlotTtlRemainingMs: number,
): AcquireDecision {
  if (globalInFlight >= GLOBAL_MAX_IN_FLIGHT) {
    // A slot frees when some slot's TTL expires or a release arrives. We
    // can't predict releases, so the lower bound is the shortest live TTL.
    // If no slots exist yet the caller passes Number.POSITIVE_INFINITY;
    // clamp to ACCRUAL_INTERVAL_MS so the caller doesn't spin.
    const retry = Number.isFinite(shortestSlotTtlRemainingMs)
      ? Math.max(1, Math.ceil(shortestSlotTtlRemainingMs))
      : ACCRUAL_INTERVAL_MS;
    return { granted: false, retryAfterMs: retry, reason: "global_cap" };
  }
  const tenantCap = maxInFlight ?? DEFAULT_TENANT_MAX_IN_FLIGHT;
  if (state.inFlight >= tenantCap) {
    // A tenant slot frees on release. No upper bound exists in pure logic,
    // so we hint one accrual interval — short enough to be responsive,
    // long enough to avoid hammering.
    return { granted: false, retryAfterMs: ACCRUAL_INTERVAL_MS, reason: "tenant_cap" };
  }
  if (state.credits < 1) {
    // Credits accrue at `weight / ACCRUAL_INTERVAL_MS` per ms. Time until
    // we reach 1 credit = (1 - credits) / weight * interval. Round up so
    // the caller waits at least until the credit actually exists.
    const deficit = 1 - state.credits;
    const retry = Math.max(1, Math.ceil((deficit / weight) * ACCRUAL_INTERVAL_MS));
    return { granted: false, retryAfterMs: retry, reason: "no_credits" };
  }
  return { granted: true };
}

// Apply a grant: spend one credit, increment in-flight counters. The
// coordinator persists state after this returns. Separated from
// decideAcquire so the decision can be tested in isolation.
export function applyGrant(state: TenantState): void {
  state.credits -= 1;
  state.inFlight += 1;
}

// Apply a release: decrement in-flight. No credit refund (DRR convention —
// the slot was consumed by a real attempt, regardless of outcome).
// inFlight is floored at 0 so a stray release for a TTL-reclaimed slot
// can never drive the counter negative.
export function applyRelease(state: TenantState): void {
  state.inFlight = Math.max(0, state.inFlight - 1);
}
