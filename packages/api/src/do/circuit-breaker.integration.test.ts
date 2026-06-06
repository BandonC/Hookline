import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { endpoints, events, tenants, deliveryAttempts } from "@hookline/db";
import type { Endpoint, Tenant } from "@hookline/db";
import { alarmUnordered } from "./endpoint-do";
import { alwaysGrantSchedulerClient } from "../scheduler-client";

// Real D1 (Miniflare) + production schema. Drives alarmUnordered against
// seeded breaker state + attempt history. fetch is stubbed per test so we
// can dictate the receiver's response. Storage is a fake that captures
// setAlarm.

const db = drizzle(env.DB);

// ten_default is seeded by migration 0006 and never deleted by per-test
// cleanup, so one fetch is enough for the whole suite. These tests exercise
// breaker semantics; the tenant gate is transparently always-grant.
const defaultTenant: Tenant = (
  await db.select().from(tenants).where(eq(tenants.id, "ten_default")).limit(1)
)[0]!;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM dead_letters");
  await env.DB.exec("DELETE FROM delivery_attempts");
  await env.DB.exec("DELETE FROM events");
  await env.DB.exec("DELETE FROM endpoints");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("ok", { status }))),
  );
}

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

async function seedEndpoint(o: {
  id: string;
  enabled?: boolean;
  state?: "closed" | "open" | "half_open";
  openUntil?: Date | null;
  openSec?: number | null;
  thresholdPct?: number | null;
}): Promise<Endpoint> {
  await db.insert(endpoints).values({
    id: o.id,
    url: `https://example.test/${o.id}`,
    signingSecret: `whsec_${o.id}`,
    ingestKey: `ingk_${o.id}`,
    circuitBreakerEnabled: o.enabled ?? true,
    breakerState: o.state ?? "closed",
    breakerOpenUntil: o.openUntil ?? null,
    breakerOpenedAt: o.state && o.state !== "closed" ? new Date(Date.now() - 1000) : null,
    breakerOpenSec: o.openSec ?? null,
    breakerThresholdPct: o.thresholdPct ?? null,
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

async function seedAttempt(o: {
  eventId: string;
  attemptedAt: Date;
  statusCode: number | null;
}) {
  await db.insert(deliveryAttempts).values({
    id: `att_${o.eventId}_${o.attemptedAt.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
    eventId: o.eventId,
    attemptNumber: 1,
    statusCode: o.statusCode,
    responseSnippet: null,
    latencyMs: 1,
    attemptedAt: o.attemptedAt,
  });
}

async function endpointRow(id: string): Promise<Endpoint> {
  const [row] = await db.select().from(endpoints).where(eq(endpoints.id, id)).limit(1);
  return row!;
}

async function lastDeferReason(eventId: string) {
  const [row] = await db
    .select({ r: events.lastDeferReason })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.r ?? null;
}

// =============================================================================
// State: open (now < open_until) — defer all
// =============================================================================

describe("alarmUnordered + breaker: open state defers all", () => {
  it("defers every due event with breaker_open and re-arms to open_until", async () => {
    stubFetch(200);
    const now = Date.now();
    const openUntil = new Date(now + 10_000);
    const endpoint = await seedEndpoint({
      id: "ep_open",
      state: "open",
      openUntil,
    });

    await seedEvent({ id: "evt_1", endpointId: endpoint.id, nextAttemptAt: new Date(now - 100) });
    await seedEvent({ id: "evt_2", endpointId: endpoint.id, nextAttemptAt: new Date(now - 200) });

    const { storage, getAlarm } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    // No fetches happened.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // Both events marked with breaker_open defer reason; status untouched.
    expect(await lastDeferReason("evt_1")).toBe("breaker_open");
    expect(await lastDeferReason("evt_2")).toBe("breaker_open");
    // Alarm re-armed to open_until.
    expect(getAlarm()).toBe(openUntil.getTime());
  });

  it("when disabled, breaker state is ignored and events deliver normally", async () => {
    stubFetch(200);
    const now = Date.now();
    const endpoint = await seedEndpoint({
      id: "ep_disabled",
      enabled: false,
      state: "open",
      openUntil: new Date(now + 10_000),
    });
    await seedEvent({ id: "evt_x", endpointId: endpoint.id, nextAttemptAt: new Date(now - 100) });

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(await lastDeferReason("evt_x")).toBeNull();
  });
});

// =============================================================================
// Closed → open: mid-loop trip on failure burst
// =============================================================================

describe("alarmUnordered + breaker: closed→open trip", () => {
  it("does NOT trip until min-samples threshold is met even at 100% failure", async () => {
    stubFetch(500);
    const now = Date.now();
    const endpoint = await seedEndpoint({ id: "ep_undershoot" });
    // Only 4 events — under BREAKER_MIN_SAMPLES (=5). 100% failure rate but not enough samples.
    for (let i = 0; i < 4; i++) {
      await seedEvent({
        id: `evt_u_${i}`,
        endpointId: endpoint.id,
        nextAttemptAt: new Date(now - 1000 + i),
      });
    }

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    const row = await endpointRow(endpoint.id);
    expect(row.breakerState).toBe("closed");
    expect(row.breakerOpenUntil).toBeNull();
  });

  it("trips to open mid-loop once threshold + min-samples are met; defers the rest", async () => {
    stubFetch(500);
    const now = Date.now();
    const endpoint = await seedEndpoint({
      id: "ep_trip",
      openSec: 60,
      thresholdPct: 50,
    });
    // 10 events, all will fail (stub returns 500). Default threshold is 50%
    // with min-samples=5 — after the 5th failure (rate=100%), breaker trips,
    // remaining 5 are deferred (not fetched).
    for (let i = 0; i < 10; i++) {
      await seedEvent({
        id: `evt_t_${i}`,
        endpointId: endpoint.id,
        nextAttemptAt: new Date(now - 1000 + i),
      });
    }

    const { storage, getAlarm } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBe(5);

    const row = await endpointRow(endpoint.id);
    expect(row.breakerState).toBe("open");
    expect(row.breakerOpenUntil).not.toBeNull();

    // Events 5..9 deferred with breaker_open. Events 0..4 actually attempted
    // (they're failed deliveries; lastDeferReason cleared by deliver()).
    for (let i = 0; i < 5; i++) {
      expect(await lastDeferReason(`evt_t_${i}`)).toBeNull();
    }
    for (let i = 5; i < 10; i++) {
      expect(await lastDeferReason(`evt_t_${i}`)).toBe("breaker_open");
    }

    // Alarm re-armed roughly open_sec into the future.
    const alarm = getAlarm()!;
    expect(alarm - now).toBeGreaterThanOrEqual(60_000 - 1000);
    expect(alarm - now).toBeLessThanOrEqual(60_000 + 2000);
  });

  it("does not trip when failure rate is below threshold", async () => {
    // Seed prior attempts: 4 successes + 1 failure in window (20% < 50%).
    const now = Date.now();
    const endpoint = await seedEndpoint({ id: "ep_low_rate", thresholdPct: 50 });
    for (let i = 0; i < 4; i++) {
      await seedEvent({
        id: `evt_pre_ok_${i}`,
        endpointId: endpoint.id,
        nextAttemptAt: new Date(now - 60_000),
      });
      await seedAttempt({
        eventId: `evt_pre_ok_${i}`,
        attemptedAt: new Date(now - 5_000),
        statusCode: 200,
      });
      await db
        .update(events)
        .set({ status: "delivered", nextAttemptAt: null })
        .where(eq(events.id, `evt_pre_ok_${i}`));
    }
    await seedEvent({
      id: "evt_pre_fail",
      endpointId: endpoint.id,
      nextAttemptAt: new Date(now - 60_000),
    });
    await seedAttempt({
      eventId: "evt_pre_fail",
      attemptedAt: new Date(now - 5_000),
      statusCode: 500,
    });
    await db
      .update(events)
      .set({ status: "delivered", nextAttemptAt: null })
      .where(eq(events.id, "evt_pre_fail"));

    // Now one new event arrives and fails — 2 failures of 6 = 33% < 50%.
    stubFetch(500);
    await seedEvent({ id: "evt_now", endpointId: endpoint.id, nextAttemptAt: new Date(now - 100) });

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const row = await endpointRow(endpoint.id);
    expect(row.breakerState).toBe("closed");
  });
});

// =============================================================================
// Half-open trial: success closes, failure re-opens
// =============================================================================

describe("alarmUnordered + breaker: half-open trial", () => {
  it("open + past open_until: CAS to half_open, deliver one event, success closes the breaker", async () => {
    stubFetch(200);
    const now = Date.now();
    const endpoint = await seedEndpoint({
      id: "ep_recover",
      state: "open",
      openUntil: new Date(now - 1000), // open_until passed → eligible for trial
    });

    // Two due events; trial should attempt only the first.
    await seedEvent({ id: "evt_trial", endpointId: endpoint.id, nextAttemptAt: new Date(now - 500) });
    await seedEvent({ id: "evt_held", endpointId: endpoint.id, nextAttemptAt: new Date(now - 400) });

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    // Exactly ONE fetch — the trial event.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Trial succeeded → breaker now closed.
    const row = await endpointRow(endpoint.id);
    expect(row.breakerState).toBe("closed");
    expect(row.breakerOpenedAt).toBeNull();
    expect(row.breakerOpenUntil).toBeNull();
  });

  it("open + past open_until: trial failure re-opens with fresh open_until", async () => {
    stubFetch(500);
    const now = Date.now();
    const oldOpenUntil = new Date(now - 1000);
    const endpoint = await seedEndpoint({
      id: "ep_reopen",
      state: "open",
      openUntil: oldOpenUntil,
      openSec: 45,
    });

    await seedEvent({ id: "evt_trial_fail", endpointId: endpoint.id, nextAttemptAt: new Date(now - 500) });

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const row = await endpointRow(endpoint.id);
    expect(row.breakerState).toBe("open");
    // Fresh open_until ~45s into the future.
    expect(row.breakerOpenUntil!.getTime()).toBeGreaterThan(now + 40_000);
    expect(row.breakerOpenUntil!.getTime()).toBeLessThan(now + 50_000);
  });

  it("option (a): half_open with no due work CASes back to open with refreshed open_until", async () => {
    stubFetch(200);
    const now = Date.now();
    const endpoint = await seedEndpoint({
      id: "ep_nowork",
      state: "open",
      openUntil: new Date(now - 1000),
      openSec: 30,
    });
    // No due events at all. The transitioner wins the CAS to half_open, finds
    // nothing to send, and must CAS back to open with a fresh open_until.

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    const row = await endpointRow(endpoint.id);
    expect(row.breakerState).toBe("open");
    expect(row.breakerOpenUntil!.getTime()).toBeGreaterThan(now + 25_000);
  });
});

// =============================================================================
// CAS race: simulated by pre-flipping state mid-flight
// =============================================================================

describe("alarmUnordered + breaker: CAS race", () => {
  it("a concurrent transition between gate-read and CAS leaves the loser deferring", async () => {
    // Setup: state=open, open_until past. Two simulated DOs. DO #1 enters
    // loadBreakerGate, wins CAS to half_open, runs trial. DO #2 enters after
    // DO #1's CAS — sees state=half_open, defers (does NOT attempt). We
    // simulate this by pre-flipping state to half_open via an external write,
    // then running alarmUnordered: it should defer, not attempt.
    stubFetch(500); // any fetch here is a bug
    const now = Date.now();
    const endpoint = await seedEndpoint({
      id: "ep_race",
      state: "half_open",
      openUntil: new Date(now - 1000),
      openSec: 30,
    });
    await seedEvent({ id: "evt_race", endpointId: endpoint.id, nextAttemptAt: new Date(now - 500) });

    const { storage, getAlarm } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    // The "loser" never fetches. The event is deferred.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(await lastDeferReason("evt_race")).toBe("breaker_open");
    // Re-arm is the pessimistic open-cycle wait (~30s).
    const alarm = getAlarm()!;
    expect(alarm - now).toBeGreaterThanOrEqual(25_000);
    expect(alarm - now).toBeLessThanOrEqual(35_000);
  });
});
