import { describe, it, expect, vi, afterEach } from "vitest";
import { reconcile } from "./index";
import { SHARDS_PER_ORDERED_ENDPOINT, computeShard } from "./sharding";

// Frozen clock: reconcile() stamps `now` for the WHERE bound. The rows we feed
// stand in for what that query returns — the SQL filter itself is exercised by
// the live `/cdn-cgi/handler/scheduled` trigger (and, in Step 6, a real-D1
// integration test). Here we test reconcile's OWN logic: dedupe + poke shape.
const NOW = new Date("2026-05-26T12:00:00Z").getTime();

type DueRow = {
  id: string;
  endpointId: string;
  orderingKey: string | null;
  nextAttemptAt: Date | null;
};

// Mock D1 at the drizzle seam reconcile() uses: select().from().where()
//   .orderBy().limit() resolves to the due rows. reconcile reads nothing else off
// the handle, so the chain only needs to terminate in our rows.
function makeDb(rows: DueRow[]) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  };
  return db as unknown as Parameters<typeof reconcile>[0];
}

// Mock the DO namespace boundary: record every poke (the exact request) so we can
// assert who got poked and with what shape.
function makeEndpointDo() {
  const pokes: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    pokes.push({ url, init, body: JSON.parse(init.body as string) });
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => ({ fetch: fetchMock }));
  const namespace = { idFromName, get } as unknown as DurableObjectNamespace;
  return { namespace, idFromName, get, fetchMock, pokes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcile", () => {
  it("re-pokes each due endpoint exactly once, using its earliest due time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    // Oldest-first, as the query returns them. ep_a appears twice (two due
    // events); ep_b once. The cron should collapse ep_a to a single poke because
    // alarm() drains all of an endpoint's due events in one run.
    const t1 = new Date(NOW - 30_000);
    const t2 = new Date(NOW - 10_000);
    const t3 = new Date(NOW - 20_000);
    const rows: DueRow[] = [
      { id: "evt_a1", endpointId: "ep_a", orderingKey: null, nextAttemptAt: t1 },
      { id: "evt_b1", endpointId: "ep_b", orderingKey: null, nextAttemptAt: t3 },
      { id: "evt_a2", endpointId: "ep_a", orderingKey: null, nextAttemptAt: t2 },
    ];
    const { namespace, idFromName, fetchMock, pokes } = makeEndpointDo();

    await reconcile(makeDb(rows), namespace);

    // One poke per distinct endpoint — not one per event.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(idFromName.mock.calls.map((c) => c[0]).sort()).toEqual(["ep_a", "ep_b"]);

    // ep_a's poke carries its EARLIEST due time (t1), not the later duplicate.
    const aPoke = pokes.find((p) => p.body.endpointId === "ep_a")!;
    expect(aPoke.body.dueAt).toBe(t1.getTime());
    expect(aPoke.body.eventId).toBe("evt_a1");
  });

  it("pokes with the exact shape ingestion uses (routes/events.ts)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const due = new Date(NOW - 5_000);
    const { namespace, fetchMock, pokes } = makeEndpointDo();

    await reconcile(
      makeDb([{ id: "evt_x", endpointId: "ep_x", orderingKey: null, nextAttemptAt: due }]),
      namespace,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hookline.internal/poke");
    expect(init.method).toBe("POST");
    expect(pokes[0].body).toEqual({
      eventId: "evt_x",
      endpointId: "ep_x",
      dueAt: due.getTime(),
      shard: null,
    });
  });

  it("routes a keyed event to its sub-DO (endpointId#shard) and carries shard in the body", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const due = new Date(NOW - 5_000);
    const key = "user_42";
    const shard = await computeShard(key);
    const { namespace, idFromName, pokes } = makeEndpointDo();

    await reconcile(
      makeDb([{ id: "evt_k", endpointId: "ep_x", orderingKey: key, nextAttemptAt: due }]),
      namespace,
    );

    expect(idFromName.mock.calls.map((c) => c[0])).toEqual([`ep_x#${shard}`]);
    expect(pokes[0].body).toEqual({
      eventId: "evt_k",
      endpointId: "ep_x",
      dueAt: due.getTime(),
      shard,
    });
  });

  it("groups by (endpoint, shard): same key → one poke, different keys → separate pokes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const due = new Date(NOW - 5_000);
    const due2 = new Date(NOW - 4_000);

    // Pick two keys with distinct shards so the routing assertion is real.
    const keyA = "k_a";
    const sA = await computeShard(keyA);
    let keyB = "k_b";
    let sB = await computeShard(keyB);
    for (let i = 0; sB === sA && i < SHARDS_PER_ORDERED_ENDPOINT * 4; i++) {
      keyB = `k_b_${i}`;
      sB = await computeShard(keyB);
    }
    expect(sB).not.toBe(sA);

    const { namespace, idFromName, pokes } = makeEndpointDo();

    await reconcile(
      makeDb([
        // Two events on key A → same sub-DO, one poke (earliest dueAt wins).
        { id: "evt_a1", endpointId: "ep_x", orderingKey: keyA, nextAttemptAt: due },
        { id: "evt_a2", endpointId: "ep_x", orderingKey: keyA, nextAttemptAt: due2 },
        // One event on key B → separate sub-DO, separate poke.
        { id: "evt_b1", endpointId: "ep_x", orderingKey: keyB, nextAttemptAt: due },
      ]),
      namespace,
    );

    expect(idFromName.mock.calls.map((c) => c[0]).sort()).toEqual(
      [`ep_x#${sA}`, `ep_x#${sB}`].sort(),
    );
    // Key A's poke carries the EARLIEST dueAt of its two events.
    const aPoke = pokes.find((p) => p.body.eventId === "evt_a1")!;
    expect(aPoke.body.dueAt).toBe(due.getTime());
  });

  it("mixed null-key + keyed events on the same endpoint poke both bare DO and sub-DOs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const due = new Date(NOW - 1_000);
    const key = "user_xyz";
    const shard = await computeShard(key);
    const { namespace, idFromName } = makeEndpointDo();

    await reconcile(
      makeDb([
        { id: "evt_null", endpointId: "ep_x", orderingKey: null, nextAttemptAt: due },
        { id: "evt_keyed", endpointId: "ep_x", orderingKey: key, nextAttemptAt: due },
      ]),
      namespace,
    );

    expect(idFromName.mock.calls.map((c) => c[0]).sort()).toEqual(
      ["ep_x", `ep_x#${shard}`].sort(),
    );
  });

  it("does nothing when no events are due", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { namespace, idFromName, fetchMock } = makeEndpointDo();

    await reconcile(makeDb([]), namespace);

    expect(idFromName).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
