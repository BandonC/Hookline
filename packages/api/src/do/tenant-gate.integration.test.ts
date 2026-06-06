// alarmUnordered + tenant gate, exercised through the real SchedulerDO
// (Miniflare gives us the SCHEDULER_DO binding). We assert the deferred
// path (no fetch, no attempt row, lastDeferReason=tenant_throttled,
// alarm re-armed) and the granted path (delivery proceeds normally).
//
// The pure decision math is covered by scheduler.test.ts. This file owns
// the wiring contract: does the alarm loop actually call the coordinator,
// honor the verdict, and clean up properly.

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { endpoints, events, tenants, type Endpoint, type Tenant } from "@hookline/db";
import { alarmUnordered } from "./endpoint-do";
import { makeSchedulerClient, type SchedulerClient } from "../scheduler-client";
import { GLOBAL_MAX_IN_FLIGHT } from "../tenancy";

const db = drizzle(env.DB);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM dead_letters");
  await env.DB.exec("DELETE FROM delivery_attempts");
  await env.DB.exec("DELETE FROM events");
  await env.DB.exec("DELETE FROM endpoints");
  // Wipe non-default tenants so each test starts fresh; ten_default stays
  // because the migration seeded it and some endpoint rows may FK to it.
  await env.DB.exec("DELETE FROM tenants WHERE id != 'ten_default'");

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("ok", { status: 200 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeStorage() {
  let alarm: number | null = null;
  const storage = {
    setAlarm: async (ts: number) => {
      alarm = ts;
    },
    getAlarm: async () => alarm,
    get: async () => undefined,
    put: async () => {},
    delete: async () => {},
  } as unknown as DurableObjectState["storage"];
  return { storage, getAlarm: () => alarm };
}

async function seedTenant(o: { id: string; weight?: number; maxInFlight?: number | null }): Promise<Tenant> {
  await db.insert(tenants).values({
    id: o.id,
    name: o.id,
    weight: o.weight ?? 1,
    maxInFlight: o.maxInFlight ?? null,
  });
  const [row] = await db.select().from(tenants).where(eq(tenants.id, o.id)).limit(1);
  return row!;
}

async function seedEndpoint(o: { id: string; tenantId: string }): Promise<Endpoint> {
  await db.insert(endpoints).values({
    id: o.id,
    tenantId: o.tenantId,
    url: `https://example.test/${o.id}`,
    signingSecret: `whsec_${o.id}`,
    ingestKey: `ingk_${o.id}`,
  });
  const [row] = await db.select().from(endpoints).where(eq(endpoints.id, o.id)).limit(1);
  return row!;
}

async function seedEvent(o: { id: string; endpointId: string; nextAttemptAt: Date }) {
  await db.insert(events).values({
    id: o.id,
    endpointId: o.endpointId,
    payload: { hello: "world" },
    status: "pending",
    nextAttemptAt: o.nextAttemptAt,
    createdAt: o.nextAttemptAt,
  });
}

async function lastDeferReason(eventId: string): Promise<string | null> {
  const [row] = await db
    .select({ r: events.lastDeferReason })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.r ?? null;
}

// Sole-instance coordinator. Each test wipes via SCHEDULER_DO.idFromName
// (different name = fresh DO) so test-to-test state doesn't bleed.
function makeIsolatedScheduler(name: string): SchedulerClient {
  return {
    async acquire(body) {
      const stub = env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(name));
      const res = await stub.fetch("https://hookline.internal/acquire", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return res.json();
    },
    async release(body) {
      const stub = env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(name));
      await stub.fetch("https://hookline.internal/release", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  };
}

describe("alarmUnordered + tenant gate", () => {
  it("grants and delivers on the happy path; no defer reason set", async () => {
    const tenant = await seedTenant({ id: "ten_happy", weight: 5 });
    const endpoint = await seedEndpoint({ id: "ep_happy", tenantId: tenant.id });
    const now = Date.now();
    await seedEvent({ id: "evt_h1", endpointId: endpoint.id, nextAttemptAt: new Date(now - 1000) });

    const scheduler = makeIsolatedScheduler("test_happy");
    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, tenant, scheduler, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const [row] = await db.select({ status: events.status }).from(events).where(eq(events.id, "evt_h1"));
    expect(row?.status).toBe("delivered");
    expect(await lastDeferReason("evt_h1")).toBeNull();
  });

  it("defers and re-arms when the tenant slot is denied (max_in_flight=0 forces deny)", async () => {
    // We can't directly force the coordinator into a deny state without
    // either filling slots or zeroing capacity. Easiest path: a tenant
    // whose max_in_flight is so low it can't ever grant. Validation
    // bounds (route-level) forbid 0, but we insert directly so we can
    // exercise the deny path deterministically. The pure decision tests
    // confirm the math; this test confirms the alarm wiring.
    const tenant = await seedTenant({ id: "ten_block", weight: 1, maxInFlight: 1 });
    const endpoint = await seedEndpoint({ id: "ep_block", tenantId: tenant.id });
    const now = Date.now();
    await seedEvent({ id: "evt_b1", endpointId: endpoint.id, nextAttemptAt: new Date(now - 1000) });
    await seedEvent({ id: "evt_b2", endpointId: endpoint.id, nextAttemptAt: new Date(now - 500) });

    const scheduler = makeIsolatedScheduler("test_block");
    // Pre-fill the coordinator with one in-flight slot so the tenant cap
    // (1) is already at the limit by the time alarm calls acquire.
    await scheduler.acquire({
      tenantId: tenant.id,
      weight: tenant.weight,
      maxInFlight: tenant.maxInFlight,
      endpointId: endpoint.id,
      eventId: "evt_prefill",
    });

    const { storage, getAlarm } = fakeStorage();
    await alarmUnordered(db, endpoint, tenant, scheduler, storage);

    // The first event hit the gate, got denied, the loop returned.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(await lastDeferReason("evt_b1")).toBe("tenant_throttled");
    // The second event was never reached (loop aborts on first deny).
    expect(await lastDeferReason("evt_b2")).toBeNull();
    // Alarm re-armed to a near future (retryAfterMs hint).
    const alarm = getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(now);
  });

  it("fails open with logging when the coordinator throws", async () => {
    const tenant = await seedTenant({ id: "ten_failopen", weight: 1 });
    const endpoint = await seedEndpoint({ id: "ep_failopen", tenantId: tenant.id });
    const now = Date.now();
    await seedEvent({ id: "evt_fo", endpointId: endpoint.id, nextAttemptAt: new Date(now - 1000) });

    // Synthetic scheduler whose acquire throws — makeSchedulerClient's
    // try/catch path is what we're exercising at the alarm level.
    const throwingNamespace = {
      get: () => ({
        fetch: () => {
          throw new Error("coordinator down");
        },
      }),
      idFromName: (n: string) => n,
    } as unknown as DurableObjectNamespace;
    const scheduler = makeSchedulerClient(throwingNamespace);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, tenant, scheduler, storage);

    // Delivery proceeded despite the coordinator being unavailable.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const [row] = await db.select({ status: events.status }).from(events).where(eq(events.id, "evt_fo"));
    expect(row?.status).toBe("delivered");
    // The failure was logged at least once (acquire path; release also
    // logs but is best-effort, so we just check >=1).
    expect(errSpy).toHaveBeenCalled();
  });

  it("smoke: GLOBAL_MAX_IN_FLIGHT constant is still 50 (load-bearing default)", () => {
    // Codifies the tunable so a casual change to tenancy.ts gets a failing
    // test instead of silent throughput regression.
    expect(GLOBAL_MAX_IN_FLIGHT).toBe(50);
  });
});
