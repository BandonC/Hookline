import { describe, it, expect } from "vitest";
import { SHARDS_PER_ORDERED_ENDPOINT, computeShard, endpointDoName } from "./sharding";

// These tests pin the routing invariant of Model C: ingestion, the cron, and
// the DO must all map a given (endpoint, ordering_key) to the SAME DO id.
// Anything that breaks that breaks per-key serialization.

describe("computeShard", () => {
  it("returns the same shard for the same key (determinism)", async () => {
    expect(await computeShard("user_42")).toBe(await computeShard("user_42"));
    expect(await computeShard("")).toBe(await computeShard(""));
  });

  it("returns a shard in [0, K)", async () => {
    for (const k of ["", "a", "user_1", "ordering.key.with.dots", "🔑"]) {
      const s = await computeShard(k);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SHARDS_PER_ORDERED_ENDPOINT);
    }
  });

  it("distributes distinct keys across multiple shards", async () => {
    // Not a strict statistical test — just a sanity check the hash isn't
    // pathologically constant. With 200 distinct keys into K=16, we expect
    // at least half the shards to see traffic.
    const shards = new Set<number>();
    for (let i = 0; i < 200; i++) shards.add(await computeShard(`k_${i}`));
    expect(shards.size).toBeGreaterThanOrEqual(SHARDS_PER_ORDERED_ENDPOINT / 2);
  });
});

describe("endpointDoName", () => {
  it("returns the bare endpointId when shard is null (v1 routing unchanged)", () => {
    expect(endpointDoName("ep_abc", null)).toBe("ep_abc");
  });

  it("returns endpointId#shard for sub-DOs, deterministically", () => {
    expect(endpointDoName("ep_abc", 3)).toBe("ep_abc#3");
    expect(endpointDoName("ep_abc", 3)).toBe(endpointDoName("ep_abc", 3));
  });

  it("bare and sub-DO names for the same endpoint are distinct (different DOs)", () => {
    expect(endpointDoName("ep_abc", null)).not.toBe(endpointDoName("ep_abc", 0));
  });
});
