import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Exercises the IngestLimiterDO end-to-end (real DO storage in workerd): the
// token bucket persists across calls and denies once drained. Uses a tiny burst
// so the behavior is reachable in a few calls; the production policy (generous
// constants) lives in routes/events.ts, not the DO.

function check(name: string, rate: number, burst: number) {
  const stub = env.INGEST_LIMITER.get(env.INGEST_LIMITER.idFromName(name));
  return stub
    .fetch("https://hookline.internal/check", {
      method: "POST",
      body: JSON.stringify({ rate, burst }),
    })
    .then((r) => r.json<{ allowed: boolean; retryAfterMs: number }>());
}

describe("IngestLimiterDO", () => {
  it("allows up to burst, then denies with a retry hint", async () => {
    const name = `ep_limit_${crypto.randomUUID()}`; // fresh DO per test run
    // rate=1/sec, burst=2 — test runs in well under a second, so refill is negligible.
    expect((await check(name, 1, 2)).allowed).toBe(true);
    expect((await check(name, 1, 2)).allowed).toBe(true);

    const denied = await check(name, 1, 2);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("keeps separate buckets per endpoint id", async () => {
    const a = `ep_a_${crypto.randomUUID()}`;
    const b = `ep_b_${crypto.randomUUID()}`;
    // Drain a's bucket (burst 1).
    expect((await check(a, 1, 1)).allowed).toBe(true);
    expect((await check(a, 1, 1)).allowed).toBe(false);
    // b is untouched.
    expect((await check(b, 1, 1)).allowed).toBe(true);
  });
});
