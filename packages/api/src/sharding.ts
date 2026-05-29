// Consistent hashing for ordered delivery: (endpoint, ordering_key) -> one of
// K sub-DOs. K is fixed in code (not per-endpoint) so ingestion, the cron, and
// the DO all derive the same shard from the same input. Changing K later means
// existing pending events may land on a different sub-DO than their ancestors
// — see HOOKLINE.md §7.

export const SHARDS_PER_ORDERED_ENDPOINT = 16;

// SHA-256(ordering_key), first 4 bytes as big-endian uint32, mod K. Web Crypto
// only — no deps. Stable across Worker invocations and across packages.
export async function computeShard(orderingKey: string): Promise<number> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(orderingKey),
  );
  return new DataView(digest).getUint32(0, false) % SHARDS_PER_ORDERED_ENDPOINT;
}

// DO addressing. Unordered endpoints keep the v1 name (bare endpointId), so
// their routing is unchanged. Ordered endpoints get `${endpointId}#${shard}`.
export function endpointDoName(endpointId: string, shard: number | null): string {
  return shard === null ? endpointId : `${endpointId}#${shard}`;
}
