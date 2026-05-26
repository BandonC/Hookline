import { describe, it, expect, vi, afterEach } from "vitest";
import { reconcile } from "./index";

// Frozen clock: reconcile() stamps `now` for the WHERE bound. The rows we feed
// stand in for what that query returns — the SQL filter itself is exercised by
// the live `/cdn-cgi/handler/scheduled` trigger (and, in Step 6, a real-D1
// integration test). Here we test reconcile's OWN logic: dedupe + poke shape.
const NOW = new Date("2026-05-26T12:00:00Z").getTime();

type DueRow = { id: string; endpointId: string; nextAttemptAt: Date | null };

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
      { id: "evt_a1", endpointId: "ep_a", nextAttemptAt: t1 },
      { id: "evt_b1", endpointId: "ep_b", nextAttemptAt: t3 },
      { id: "evt_a2", endpointId: "ep_a", nextAttemptAt: t2 },
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
      makeDb([{ id: "evt_x", endpointId: "ep_x", nextAttemptAt: due }]),
      namespace,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hookline.internal/poke");
    expect(init.method).toBe("POST");
    expect(pokes[0].body).toEqual({
      eventId: "evt_x",
      endpointId: "ep_x",
      dueAt: due.getTime(),
    });
  });

  it("does nothing when no events are due", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { namespace, idFromName, fetchMock } = makeEndpointDo();

    await reconcile(makeDb([]), namespace);

    expect(idFromName).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
