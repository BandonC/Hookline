import { describe, it, expect } from "vitest";
import { initialBucket, consumeToken } from "./ingest-limit";

// Token-bucket math for the ingestion rate limiter. Fixed clock — no real time.

describe("consumeToken", () => {
  const RATE = 10; // tokens/sec
  const BURST = 5;

  it("starts full and allows up to `burst` immediate requests", () => {
    let state = initialBucket(BURST, 0);
    for (let i = 0; i < BURST; i++) {
      const r = consumeToken(state, RATE, BURST, 0); // same instant, no refill
      expect(r.allowed).toBe(true);
      state = r.state;
    }
    // Bucket now empty at t=0 → next is denied.
    const denied = consumeToken(state, RATE, BURST, 0);
    expect(denied.allowed).toBe(false);
  });

  it("reports a retryAfter that covers the refill of one token when empty", () => {
    const empty = { tokens: 0, lastRefillMs: 0 };
    const r = consumeToken(empty, RATE, BURST, 0);
    expect(r.allowed).toBe(false);
    // 1 token at 10/sec = 100ms.
    expect(r.retryAfterMs).toBe(100);
  });

  it("refills over elapsed time, then allows again", () => {
    const empty = { tokens: 0, lastRefillMs: 0 };
    // 250ms later at 10/sec → 2.5 tokens accrued.
    const r = consumeToken(empty, RATE, BURST, 250);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBeCloseTo(1.5, 5); // 2.5 accrued − 1 spent
  });

  it("never accrues beyond burst", () => {
    const empty = { tokens: 0, lastRefillMs: 0 };
    // A long gap would accrue 100 tokens uncapped; burst clamps to 5, minus 1 spent.
    const r = consumeToken(empty, RATE, BURST, 10_000);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBeCloseTo(BURST - 1, 5);
  });
});
