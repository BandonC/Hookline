// Per-endpoint DO's view of the coordinator. Wraps the DO RPC behind a small
// interface so alarm() takes a SchedulerClient rather than a raw
// DurableObjectNamespace — production wires the real one, integration tests
// for breaker / rate-limit pass `alwaysGrantSchedulerClient` so those tests
// don't have to model the tenant gate.

import { SLOT_TTL_MS } from "./tenancy";

const SCHEDULER_DO_NAME = "scheduler";

export type AcquireBody = {
  tenantId: string;
  weight: number;
  maxInFlight: number | null;
  // For coordinator-side logging; not used in decisions.
  endpointId: string;
  eventId: string;
};

export type AcquireResult =
  | { granted: true; slotToken: string; ttlMs: number }
  | { granted: false; retryAfterMs: number; reason: "global_cap" | "tenant_cap" | "no_credits" };

export type ReleaseBody = {
  slotToken: string;
  outcome: "delivered" | "failed" | "error";
};

export type SchedulerClient = {
  acquire(body: AcquireBody): Promise<AcquireResult>;
  release(body: ReleaseBody): Promise<void>;
};

// Production client. Both methods are fail-open: if the coordinator throws,
// times out, or returns non-2xx, acquire returns granted=true with a
// synthetic token so deliver() proceeds. Rationale (locked in design):
// at-least-once is sacred; tenant fairness is not. A coordinator outage
// degrades to v1 behavior. Every fail-open path is logged.
export function makeSchedulerClient(namespace: DurableObjectNamespace): SchedulerClient {
  const stub = () => namespace.get(namespace.idFromName(SCHEDULER_DO_NAME));
  return {
    async acquire(body) {
      try {
        const res = await stub().fetch("https://hookline.internal/acquire", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          console.error("scheduler acquire non-ok; failing open", res.status);
          return failOpenGrant();
        }
        return await res.json<AcquireResult>();
      } catch (err) {
        console.error("scheduler acquire threw; failing open", err);
        return failOpenGrant();
      }
    },
    async release(body) {
      try {
        const res = await stub().fetch("https://hookline.internal/release", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) console.error("scheduler release non-ok", res.status);
      } catch (err) {
        // Slot will be TTL-reclaimed by the coordinator's lazy sweep; log
        // and move on rather than throwing inside the finally block.
        console.error("scheduler release threw (slot will TTL-reclaim)", err);
      }
    },
  };
}

// Synthetic grant used on coordinator outage. The token is decorated so it's
// obvious in logs that it never came from the coordinator. Release calls for
// these tokens go to the real coordinator anyway — they'll be no-ops because
// the coordinator never saw the acquire (idempotent release on unknown token).
function failOpenGrant(): AcquireResult {
  return {
    granted: true,
    slotToken: `slot_failopen_${crypto.randomUUID()}`,
    ttlMs: SLOT_TTL_MS,
  };
}

// Test fixture. Tests for unrelated gates (breaker, rate-limit) pass this so
// the tenant gate is effectively transparent. Not exported as part of any
// production code path.
export const alwaysGrantSchedulerClient: SchedulerClient = {
  async acquire() {
    return { granted: true, slotToken: "slot_test_grant", ttlMs: SLOT_TTL_MS };
  },
  async release() {},
};
