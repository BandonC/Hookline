import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { endpoints, events } from "@hookline/db";
import { ownedHeads } from "./endpoint-do";
import { SHARDS_PER_ORDERED_ENDPOINT, computeShard } from "../sharding";

// Real D1 (Miniflare) with the production schema applied (test/apply-migrations.ts).
// Tests the per-key head selection that HOLB correctness rides on:
//   - within a key, the head is the OLDEST pending event by created_at;
//   - a head with a future next_attempt_at still blocks younger same-key events
//     (we wait on the head, never skip);
//   - the shard filter actually filters (keys whose hash != self.shard are not
//     returned).
// These claims can't be expressed against the unit-test mocks — they require
// real SQLite ordering + the actual index path.

const db = drizzle(env.DB);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM events");
  await env.DB.exec("DELETE FROM endpoints");
});

async function seedEndpoint(id: string) {
  await db
    .insert(endpoints)
    .values({ id, url: `https://example.test/${id}`, signingSecret: `whsec_${id}`, ingestKey: `ingk_${id}` });
}

type SeedEvent = {
  id: string;
  endpointId: string;
  orderingKey: string | null;
  status?: "pending" | "delivered" | "failed";
  createdAt: Date;
  nextAttemptAt: Date | null;
};

async function seedEvents(rows: SeedEvent[]) {
  await db.insert(events).values(
    rows.map((r) => ({
      id: r.id,
      endpointId: r.endpointId,
      payload: {},
      status: r.status ?? "pending",
      orderingKey: r.orderingKey,
      nextAttemptAt: r.nextAttemptAt,
      createdAt: r.createdAt,
    })),
  );
}

describe("ownedHeads (real D1)", () => {
  it("returns the oldest pending event per (endpoint, key)", async () => {
    await seedEndpoint("ep_x");
    const key = "user_42";
    const shard = await computeShard(key);

    const t0 = new Date("2026-05-01T00:00:00Z");
    const t1 = new Date("2026-05-01T00:01:00Z");
    const t2 = new Date("2026-05-01T00:02:00Z");

    await seedEvents([
      // Older + middle + newest, all pending, all same key. Head = oldest.
      { id: "evt_old", endpointId: "ep_x", orderingKey: key, createdAt: t0, nextAttemptAt: new Date() },
      { id: "evt_mid", endpointId: "ep_x", orderingKey: key, createdAt: t1, nextAttemptAt: new Date() },
      { id: "evt_new", endpointId: "ep_x", orderingKey: key, createdAt: t2, nextAttemptAt: new Date() },
    ]);

    const heads = await ownedHeads(db, "ep_x", shard);
    expect(heads.map((e) => e.id)).toEqual(["evt_old"]);
  });

  it("excludes delivered/failed events and null-key events from head consideration", async () => {
    await seedEndpoint("ep_y");
    const key = "user_test";
    const shard = await computeShard(key);

    const t0 = new Date("2026-05-01T00:00:00Z");
    const t1 = new Date("2026-05-01T00:01:00Z");

    await seedEvents([
      // Older than the head, but delivered → must not be picked as head.
      { id: "evt_done", endpointId: "ep_y", orderingKey: key, status: "delivered", createdAt: t0, nextAttemptAt: null },
      // The actual head.
      { id: "evt_head", endpointId: "ep_y", orderingKey: key, createdAt: t1, nextAttemptAt: new Date() },
      // Null-key event — owned by the bare DO, must not appear here.
      { id: "evt_nullkey", endpointId: "ep_y", orderingKey: null, createdAt: t0, nextAttemptAt: new Date() },
    ]);

    const heads = await ownedHeads(db, "ep_y", shard);
    expect(heads.map((e) => e.id)).toEqual(["evt_head"]);
  });

  it("a head with a future next_attempt_at remains the head — younger same-key events do NOT take its place", async () => {
    // The defining HOLB property. If a v1-style "drain all due" sneaks back in,
    // this test catches it: the younger event would be returned and delivered
    // out of order.
    await seedEndpoint("ep_z");
    const key = "user_blocked";
    const shard = await computeShard(key);

    const now = Date.now();
    await seedEvents([
      // Head: created earlier, scheduled in the FUTURE (e.g. a retrying event
      // on the decorrelated-jitter curve).
      {
        id: "evt_head_retry",
        endpointId: "ep_z",
        orderingKey: key,
        createdAt: new Date(now - 60_000),
        nextAttemptAt: new Date(now + 300_000),
      },
      // Younger event in the SAME key, already due — must wait behind head.
      {
        id: "evt_behind",
        endpointId: "ep_z",
        orderingKey: key,
        createdAt: new Date(now - 30_000),
        nextAttemptAt: new Date(now),
      },
    ]);

    const heads = await ownedHeads(db, "ep_z", shard);
    expect(heads.map((e) => e.id)).toEqual(["evt_head_retry"]);
  });

  it("filters to keys owned by this shard — other shards' heads are not returned", async () => {
    await seedEndpoint("ep_q");
    const key = "user_42";
    const shard = await computeShard(key);
    const wrongShard = (shard + 1) % SHARDS_PER_ORDERED_ENDPOINT;

    await seedEvents([
      { id: "evt_k", endpointId: "ep_q", orderingKey: key, createdAt: new Date(), nextAttemptAt: new Date() },
    ]);

    expect((await ownedHeads(db, "ep_q", shard)).map((e) => e.id)).toEqual(["evt_k"]);
    expect((await ownedHeads(db, "ep_q", wrongShard)).map((e) => e.id)).toEqual([]);
  });
});
