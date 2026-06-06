import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { endpoints, events, tenants, deliveryAttempts } from "@hookline/db";
import type { Endpoint, Tenant } from "@hookline/db";
import { alarmOrdered, alarmUnordered } from "./endpoint-do";
import { computeShard } from "../sharding";
import { alwaysGrantSchedulerClient } from "../scheduler-client";

// Real D1 (Miniflare) + the production schema. Drives alarmUnordered /
// alarmOrdered with seeded attempt history so the bucket has a known fill.
// fetch is stubbed so deliveries don't escape; storage is a fake that
// captures setAlarm so we can assert the defer time.

const db = drizzle(env.DB);

// Loaded once: ten_default survives per-test cleanup. Rate-limit tests
// pass it through with an always-grant scheduler so the tenant gate is
// transparent.
const defaultTenant: Tenant = (
  await db.select().from(tenants).where(eq(tenants.id, "ten_default")).limit(1)
)[0]!;

beforeEach(async () => {
  // events references endpoints; delivery_attempts references events.
  await env.DB.exec("DELETE FROM delivery_attempts");
  await env.DB.exec("DELETE FROM events");
  await env.DB.exec("DELETE FROM endpoints");
  // Default stub: every delivery succeeds. Tests override for specific
  // failure scenarios. Stubbed per test to keep call counts clean.
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

async function seedEndpoint(o: {
  id: string;
  rateLimitRps?: number | null;
  rateLimitBurst?: number | null;
  ordered?: boolean;
}): Promise<Endpoint> {
  await db.insert(endpoints).values({
    id: o.id,
    url: `https://example.test/${o.id}`,
    signingSecret: `whsec_${o.id}`,
    ingestKey: `ingk_${o.id}`,
    ordered: o.ordered ?? false,
    rateLimitRps: o.rateLimitRps ?? null,
    rateLimitBurst: o.rateLimitBurst ?? null,
  });
  const [row] = await db.select().from(endpoints).where(eq(endpoints.id, o.id)).limit(1);
  return row!;
}

async function seedEvent(o: {
  id: string;
  endpointId: string;
  orderingKey?: string | null;
  nextAttemptAt: Date;
  createdAt?: Date;
}) {
  await db.insert(events).values({
    id: o.id,
    endpointId: o.endpointId,
    payload: { hello: "world" },
    status: "pending",
    orderingKey: o.orderingKey ?? null,
    nextAttemptAt: o.nextAttemptAt,
    createdAt: o.createdAt ?? o.nextAttemptAt,
  });
}

async function seedAttempt(o: { eventId: string; attemptedAt: Date }) {
  await db.insert(deliveryAttempts).values({
    id: `att_${o.eventId}_${o.attemptedAt.getTime()}`,
    eventId: o.eventId,
    attemptNumber: 1,
    statusCode: 200,
    responseSnippet: null,
    latencyMs: 1,
    attemptedAt: o.attemptedAt,
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

// =============================================================================
// alarmUnordered — bare DO path
// =============================================================================

describe("alarmUnordered + rate limit (real D1)", () => {
  it("with no rate config, delivers all due events (today's v1 behavior)", async () => {
    const endpoint = await seedEndpoint({ id: "ep_norate" });
    const now = Date.now();
    await seedEvent({ id: "evt_a", endpointId: endpoint.id, nextAttemptAt: new Date(now - 1000) });
    await seedEvent({ id: "evt_b", endpointId: endpoint.id, nextAttemptAt: new Date(now - 1000) });

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    // Both delivered (one fetch each), neither carries a defer reason.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(await lastDeferReason("evt_a")).toBeNull();
    expect(await lastDeferReason("evt_b")).toBeNull();
  });

  it("when the bucket is dry, defers the first event without firing fetch", async () => {
    // rps=1 burst=1, and a recent attempt drained the bucket — bucket is empty.
    const endpoint = await seedEndpoint({ id: "ep_dry", rateLimitRps: 1, rateLimitBurst: 1 });
    const now = Date.now();

    // Drain bucket with a recent attempt on an unrelated null-key event.
    await seedEvent({
      id: "evt_drain",
      endpointId: endpoint.id,
      nextAttemptAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    });
    await seedAttempt({ eventId: "evt_drain", attemptedAt: new Date(now - 100) });
    // Mark the drain event delivered so it's not in `due`.
    await db.update(events).set({ status: "delivered", nextAttemptAt: null }).where(eq(events.id, "evt_drain"));

    // The actual due event the alarm sees.
    await seedEvent({ id: "evt_due", endpointId: endpoint.id, nextAttemptAt: new Date(now - 500) });

    const { storage, getAlarm } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(await lastDeferReason("evt_due")).toBe("rate_limited");
    // Alarm moved to ~1s after the drain (next-token time at rps=1).
    const alarm = getAlarm()!;
    expect(alarm).toBeGreaterThan(now);
    expect(alarm - (now - 100)).toBeGreaterThanOrEqual(1000 - 50); // within ~50ms slop
  });

  it("delivers within bucket budget, then defers mid-loop when the bucket runs dry", async () => {
    // rps=1 burst=3, three due events, no prior attempts -> delivers 3 then would defer if a 4th existed.
    const endpoint = await seedEndpoint({ id: "ep_burst3", rateLimitRps: 1, rateLimitBurst: 3 });
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await seedEvent({
        id: `evt_${i}`,
        endpointId: endpoint.id,
        nextAttemptAt: new Date(now - 5_000 + i),
        createdAt: new Date(now - 5_000 + i),
      });
    }

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    // 3 delivered, 4th deferred.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(await lastDeferReason("evt_0")).toBeNull();
    expect(await lastDeferReason("evt_1")).toBeNull();
    expect(await lastDeferReason("evt_2")).toBeNull();
    expect(await lastDeferReason("evt_3")).toBe("rate_limited");
  });

  it("clears last_defer_reason on the next successful delivery", async () => {
    // Pre-seed an event already marked throttled. With no rate config, alarm
    // delivers it and the deliver() batch clears the reason.
    const endpoint = await seedEndpoint({ id: "ep_clear" });
    const now = Date.now();
    await seedEvent({ id: "evt_was_throttled", endpointId: endpoint.id, nextAttemptAt: new Date(now - 1000) });
    await db
      .update(events)
      .set({ lastDeferReason: "rate_limited" })
      .where(eq(events.id, "evt_was_throttled"));

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect(await lastDeferReason("evt_was_throttled")).toBeNull();
  });
});

// =============================================================================
// alarmOrdered — sub-DO path
// =============================================================================

describe("alarmOrdered + rate limit (real D1)", () => {
  it("rate gate fires AFTER due+owned: defers an owned-and-due head when the bucket is dry", async () => {
    const endpoint = await seedEndpoint({
      id: "ep_ord",
      ordered: true,
      rateLimitRps: 1,
      rateLimitBurst: 1,
    });
    const key = "user_42";
    const shard = await computeShard(key);
    const now = Date.now();

    // Prior attempt on this same key (this shard) drained the bucket.
    await seedEvent({
      id: "evt_prior",
      endpointId: endpoint.id,
      orderingKey: key,
      nextAttemptAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    });
    await seedAttempt({ eventId: "evt_prior", attemptedAt: new Date(now - 100) });
    await db
      .update(events)
      .set({ status: "delivered", nextAttemptAt: null })
      .where(eq(events.id, "evt_prior"));

    // Due head: should be picked by ownedHeads, then declined by the rate gate.
    await seedEvent({
      id: "evt_head",
      endpointId: endpoint.id,
      orderingKey: key,
      nextAttemptAt: new Date(now - 500),
      createdAt: new Date(now - 500),
    });

    const { storage, getAlarm } = fakeStorage();
    await alarmOrdered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, shard, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(await lastDeferReason("evt_head")).toBe("rate_limited");
    expect(getAlarm()).toBeGreaterThan(now);
  });

  it("per-shard isolation: attempts on shard A do not drain shard B's bucket", async () => {
    // Two keys deliberately on different shards (find a pair).
    const endpoint = await seedEndpoint({
      id: "ep_iso",
      ordered: true,
      rateLimitRps: 1,
      rateLimitBurst: 1,
    });
    const keyA = "key_a";
    const shardA = await computeShard(keyA);
    let keyB = "key_b";
    let shardB = await computeShard(keyB);
    let i = 0;
    while (shardB === shardA) {
      i += 1;
      keyB = `key_b_${i}`;
      shardB = await computeShard(keyB);
    }

    const now = Date.now();

    // Drain shard A's bucket with a prior attempt on keyA.
    await seedEvent({
      id: "evt_a_prior",
      endpointId: endpoint.id,
      orderingKey: keyA,
      nextAttemptAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    });
    await seedAttempt({ eventId: "evt_a_prior", attemptedAt: new Date(now - 100) });
    await db
      .update(events)
      .set({ status: "delivered", nextAttemptAt: null })
      .where(eq(events.id, "evt_a_prior"));

    // Due heads on both shards, both should be picked by their owners.
    await seedEvent({
      id: "evt_a_head",
      endpointId: endpoint.id,
      orderingKey: keyA,
      nextAttemptAt: new Date(now - 500),
      createdAt: new Date(now - 500),
    });
    await seedEvent({
      id: "evt_b_head",
      endpointId: endpoint.id,
      orderingKey: keyB,
      nextAttemptAt: new Date(now - 500),
      createdAt: new Date(now - 500),
    });

    // Shard A: dry, defers.
    const a = fakeStorage();
    await alarmOrdered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, shardA, a.storage);
    expect(await lastDeferReason("evt_a_head")).toBe("rate_limited");

    // Shard B: full bucket (no prior attempts on shard B), delivers.
    const b = fakeStorage();
    await alarmOrdered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, shardB, b.storage);
    expect(await lastDeferReason("evt_b_head")).toBeNull();
    // Delivered: status flipped to delivered.
    const [bRow] = await db.select({ s: events.status }).from(events).where(eq(events.id, "evt_b_head")).limit(1);
    expect(bRow!.s).toBe("delivered");
  });

  it("with no rate config on an ordered endpoint, the gate is skipped (today's v2 behavior)", async () => {
    const endpoint = await seedEndpoint({ id: "ep_ord_norate", ordered: true });
    const key = "user_x";
    const shard = await computeShard(key);
    const now = Date.now();

    await seedEvent({
      id: "evt_ord",
      endpointId: endpoint.id,
      orderingKey: key,
      nextAttemptAt: new Date(now - 500),
      createdAt: new Date(now - 500),
    });

    const { storage } = fakeStorage();
    await alarmOrdered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, shard, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(await lastDeferReason("evt_ord")).toBeNull();
  });
});

// =============================================================================
// Bucket scope sanity — bare DO ignores keyed attempts, and vice versa
// =============================================================================

describe("rate gate shard scoping (real D1)", () => {
  it("bare DO's bucket ignores attempts from keyed events", async () => {
    // rps=1 burst=1. A keyed event's prior attempt should NOT drain the bare
    // DO's bucket — the bare DO only counts null-key attempts.
    const endpoint = await seedEndpoint({
      id: "ep_scope",
      rateLimitRps: 1,
      rateLimitBurst: 1,
    });
    const now = Date.now();

    // Keyed event with recent attempt. Belongs to a sub-DO, NOT the bare DO.
    await seedEvent({
      id: "evt_keyed_prior",
      endpointId: endpoint.id,
      orderingKey: "some_key",
      nextAttemptAt: new Date(now - 60_000),
      createdAt: new Date(now - 60_000),
    });
    await seedAttempt({ eventId: "evt_keyed_prior", attemptedAt: new Date(now - 100) });

    // Null-key due event. The bare DO's bucket should be full (no null-key attempts).
    await seedEvent({
      id: "evt_bare",
      endpointId: endpoint.id,
      orderingKey: null,
      nextAttemptAt: new Date(now - 500),
    });

    const { storage } = fakeStorage();
    await alarmUnordered(db, endpoint, defaultTenant, alwaysGrantSchedulerClient, storage);

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(await lastDeferReason("evt_bare")).toBeNull();
  });
});
