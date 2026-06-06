import { describe, it, expect, vi, afterEach } from "vitest";
import { deliver } from "./endpoint-do";
import { signPayload } from "../signing";
import { deliveryAttempts, events, deadLetters } from "@hookline/db";
import type { Event, Endpoint } from "@hookline/db";

// Mirror of MAX_ATTEMPTS in endpoint-do.ts. Asserting against the literal here
// keeps the dead-letter test honest if that constant is silently changed.
const MAX_ATTEMPTS = 6;

// Frozen clock so the per-attempt timestamp, latency, and next_attempt_at are
// deterministic (no flaky tests — root CLAUDE.md testing rule).
const NOW = new Date("2026-05-25T12:00:00Z").getTime();
const TS_SECONDS = Math.floor(NOW / 1000);

// Mock D1 at the drizzle seam deliver() actually uses: insert/update builders
// and a recording batch(). deliver() never reads results back, so the builders
// only need to capture what was written. We assert on the captured batch.
type Stmt = {
  op: "insert" | "update";
  table: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
};

function makeDb() {
  const batches: Stmt[][] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>): Stmt => ({ op: "insert", table, values }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (_cond: unknown): Stmt => ({ op: "update", table, set }),
      }),
    }),
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts);
      return [];
    },
  };
  return { db, batches };
}
type MockDb = ReturnType<typeof makeDb>["db"];

// deliver() takes a drizzle handle; substitute our recording mock for that D1
// dependency (do/CLAUDE.md: mock the boundary — network, D1, time — not the unit
// under test). This is the only cast, and it's a standard dependency swap.
const asDb = (mock: MockDb) => mock as unknown as Parameters<typeof deliver>[0];

const endpoint: Endpoint = {
  id: "ep_test",
  tenantId: "ten_default",
  url: "https://receiver.example/hook",
  signingSecret: "whsec_test_secret",
  ingestKey: "ingk_test",
  description: null,
  ordered: false,
  rateLimitRps: null,
  rateLimitBurst: null,
  circuitBreakerEnabled: false,
  breakerOpenSec: null,
  breakerThresholdPct: null,
  breakerState: "closed",
  breakerOpenedAt: null,
  breakerOpenUntil: null,
  createdAt: new Date(NOW),
};

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt_abc",
    endpointId: "ep_test",
    payload: { hello: "world" },
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date(NOW),
    lastDelayMs: null,
    orderingKey: null,
    lastDeferReason: null,
    createdAt: new Date(NOW),
    ...overrides,
  };
}

function stubFetch(status: number) {
  const mock = vi.fn((_input: string, _init?: RequestInit) =>
    Promise.resolve(new Response("body", { status })),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deliver", () => {
  it("signs the envelope and on 2xx writes one attempt + marks delivered in one batch", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fetchMock = stubFetch(200);
    const { db, batches } = makeDb();
    const event = makeEvent();

    await deliver(asDb(db), event, endpoint);

    // Invariant 3: exactly one batch, attempt row first, event mutation rides along.
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch).toHaveLength(2);

    expect(batch[0]).toMatchObject({
      op: "insert",
      table: deliveryAttempts,
      values: { eventId: "evt_abc", attemptNumber: 1, statusCode: 200 },
    });
    expect(batch[1]).toMatchObject({
      op: "update",
      table: events,
      set: { status: "delivered", nextAttemptAt: null },
    });

    // Invariant 2/5: the id is INSIDE the signed body, and the header signature
    // verifies over `${timestamp}.${rawBody}` for the exact bytes POSTed.
    const init = fetchMock.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    const rawBody = init.body as string;

    expect(JSON.parse(rawBody)).toEqual({ id: "evt_abc", payload: { hello: "world" } });
    expect(headers["X-Hookline-Timestamp"]).toBe(String(TS_SECONDS));
    expect(headers["X-Hookline-Event-Id"]).toBe("evt_abc");
    expect(headers["X-Hookline-Signature"]).toBe(
      await signPayload(endpoint.signingSecret, rawBody, TS_SECONDS),
    );
  });

  it("on a non-2xx under max attempts records status_code and schedules a retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    stubFetch(500);
    const { db, batches } = makeDb();

    await deliver(asDb(db), makeEvent({ attemptCount: 0 }), endpoint);

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch).toHaveLength(2); // attempt + reschedule, no dead-letter

    expect(batch[0]).toMatchObject({
      op: "insert",
      table: deliveryAttempts,
      values: { attemptNumber: 1, statusCode: 500 },
    });

    // Retry branch: attempt_count advances, a future next_attempt_at is set, and
    // status is NOT touched (the event stays pending for alarm() to re-arm).
    const reschedule = batch[1];
    expect(reschedule.op).toBe("update");
    expect(reschedule.table).toBe(events);
    expect(reschedule.set!.status).toBeUndefined();
    expect(reschedule.set!.attemptCount).toBe(1);
    expect(typeof reschedule.set!.lastDelayMs).toBe("number");
    expect(reschedule.set!.nextAttemptAt).toBeInstanceOf(Date);
    expect((reschedule.set!.nextAttemptAt as Date).getTime()).toBeGreaterThan(NOW);
  });

  it("on a non-2xx at max attempts marks failed and dead-letters with HTTP <code>", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    stubFetch(500);
    const { db, batches } = makeDb();

    // attemptCount = MAX-1 → this attempt is the MAX-th, so retries are exhausted.
    await deliver(asDb(db), makeEvent({ attemptCount: MAX_ATTEMPTS - 1 }), endpoint);

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch).toHaveLength(3); // attempt + fail + dead-letter

    expect(batch[0]).toMatchObject({
      op: "insert",
      table: deliveryAttempts,
      values: { attemptNumber: MAX_ATTEMPTS, statusCode: 500 },
    });
    expect(batch[1]).toMatchObject({
      op: "update",
      table: events,
      set: { status: "failed", nextAttemptAt: null, attemptCount: MAX_ATTEMPTS },
    });
    // Never a silent drop: the exhausted event lands in dead_letters.
    expect(batch[2]).toMatchObject({
      op: "insert",
      table: deadLetters,
      values: { eventId: "evt_abc", finalError: "HTTP 500" },
    });
  });
});
