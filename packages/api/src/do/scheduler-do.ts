// Coordinator Durable Object: single instance (idFromName("scheduler")) that
// holds per-tenant credit/in-flight state + the global slot ledger. Every
// per-endpoint DO calls /acquire before deliver() and /release after, so
// fairness is enforced at the one place that can see across tenants.
//
// Pure decision logic lives in ../scheduler.ts; this file owns storage and
// HTTP. Mirrors the backoff.ts vs endpoint-do.ts split.
//
// Storage layout:
//   tenant:<tenantId>  -> TenantState
//   slot:<slotToken>   -> { tenantId, acquiredAt }
//   globalInFlight     -> number (maintained, not derived per call)
//
// Why globalInFlight is materialized rather than computed by listing slots:
// every /acquire reads it; storage.list on a small key set is fine but the
// scalar read is one storage get vs a prefix scan + count.

import { nanoid } from "nanoid";
import {
  initialTenantState,
  advanceCredits,
  decideAcquire,
  applyGrant,
  applyRelease,
  type TenantState,
} from "../scheduler";
import { SLOT_TTL_MS } from "../tenancy";

type Slot = { tenantId: string; acquiredAt: number };

type AcquireBody = {
  tenantId: string;
  // Tenant config is passed in by the caller (per-endpoint DO already
  // joined endpoints → tenants when loading endpoint config), so the
  // coordinator never touches D1. Eventually consistent: if a config
  // update raced, the next acquire reflects it.
  weight: number;
  maxInFlight: number | null;
  // Optional, for logs only. Coordinator does not key off these.
  endpointId?: string;
  eventId?: string;
};

type ReleaseBody = {
  slotToken: string;
  // Informational — lets the coordinator track per-tenant success rate
  // later if we ever want adaptive weighting. Not used today.
  outcome: "delivered" | "failed" | "error";
};

export class SchedulerDO {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/acquire") {
      return this.handleAcquire(await req.json<AcquireBody>());
    }
    if (req.method === "POST" && url.pathname === "/release") {
      return this.handleRelease(await req.json<ReleaseBody>());
    }
    return new Response("not found", { status: 404 });
  }

  private async handleAcquire(body: AcquireBody): Promise<Response> {
    const now = Date.now();
    const storage = this.state.storage;

    // Lazy TTL sweep first — reclaim any slot whose holder crashed or was
    // evicted mid-delivery. Done before reading globalInFlight so the
    // counter reflects post-sweep reality.
    await this.sweepExpiredSlots(now);

    let tenantState =
      (await storage.get<TenantState>(`tenant:${body.tenantId}`)) ?? initialTenantState(now);
    advanceCredits(tenantState, body.weight, now);

    const globalInFlight = (await storage.get<number>("globalInFlight")) ?? 0;
    const shortestSlotTtlRemainingMs = await this.shortestSlotTtlRemaining(now);

    const decision = decideAcquire(
      tenantState,
      body.weight,
      body.maxInFlight,
      globalInFlight,
      shortestSlotTtlRemainingMs,
    );

    if (!decision.granted) {
      // Persist the advanced credits + lastTouchedAt even on deny — the
      // accrual clock moves forward whether or not we grant. Skipping
      // this would let a denied tenant repeatedly "lose" small amounts
      // of accrual on each polling re-arm.
      await storage.put(`tenant:${body.tenantId}`, tenantState);
      return Response.json({
        granted: false,
        retryAfterMs: decision.retryAfterMs,
        reason: decision.reason,
      });
    }

    applyGrant(tenantState);
    const slotToken = `slot_${nanoid()}`;
    const slot: Slot = { tenantId: body.tenantId, acquiredAt: now };

    await storage.put(`tenant:${body.tenantId}`, tenantState);
    await storage.put(`slot:${slotToken}`, slot);
    await storage.put("globalInFlight", globalInFlight + 1);

    return Response.json({ granted: true, slotToken, ttlMs: SLOT_TTL_MS });
  }

  private async handleRelease(body: ReleaseBody): Promise<Response> {
    const storage = this.state.storage;
    const slotKey = `slot:${body.slotToken}`;
    const slot = await storage.get<Slot>(slotKey);

    // Idempotent: unknown / already-reclaimed tokens succeed silently.
    // Two reasons: (1) the per-endpoint DO calls release in a finally
    // block — if a slot was already TTL-swept, the release shouldn't
    // throw; (2) fail-open paths mint a synthetic token the coordinator
    // never knew about.
    if (!slot) return new Response(null, { status: 204 });

    const tenantKey = `tenant:${slot.tenantId}`;
    const tenantState = await storage.get<TenantState>(tenantKey);
    if (tenantState) {
      applyRelease(tenantState);
      await storage.put(tenantKey, tenantState);
    }

    const globalInFlight = (await storage.get<number>("globalInFlight")) ?? 0;
    await storage.put("globalInFlight", Math.max(0, globalInFlight - 1));
    await storage.delete(slotKey);

    return new Response(null, { status: 204 });
  }

  // Reclaim every slot older than SLOT_TTL_MS. Updates each affected
  // tenant's inFlight + globalInFlight in one batch of storage writes.
  // Called at the start of every acquire — lazy, no alarm needed.
  private async sweepExpiredSlots(now: number): Promise<void> {
    const slots = await this.state.storage.list<Slot>({ prefix: "slot:" });
    const expiredKeys: string[] = [];
    const inFlightDecrements = new Map<string, number>();

    for (const [key, slot] of slots) {
      if (now - slot.acquiredAt > SLOT_TTL_MS) {
        expiredKeys.push(key);
        inFlightDecrements.set(slot.tenantId, (inFlightDecrements.get(slot.tenantId) ?? 0) + 1);
      }
    }
    if (expiredKeys.length === 0) return;

    const storage = this.state.storage;
    for (const [tenantId, dec] of inFlightDecrements) {
      const state = await storage.get<TenantState>(`tenant:${tenantId}`);
      if (!state) continue;
      state.inFlight = Math.max(0, state.inFlight - dec);
      await storage.put(`tenant:${tenantId}`, state);
    }
    const globalInFlight = (await storage.get<number>("globalInFlight")) ?? 0;
    await storage.put("globalInFlight", Math.max(0, globalInFlight - expiredKeys.length));
    await storage.delete(expiredKeys);
  }

  // Shortest remaining TTL across all live slots, in ms. Used as the
  // retryAfter hint when the global cap binds (no other event gives us
  // a better lower bound). POSITIVE_INFINITY when there are no slots,
  // which the pure decision function clamps to ACCRUAL_INTERVAL_MS.
  private async shortestSlotTtlRemaining(now: number): Promise<number> {
    const slots = await this.state.storage.list<Slot>({ prefix: "slot:" });
    let shortest = Number.POSITIVE_INFINITY;
    for (const [, slot] of slots) {
      const remaining = SLOT_TTL_MS - (now - slot.acquiredAt);
      if (remaining < shortest) shortest = remaining;
    }
    return shortest;
  }
}
