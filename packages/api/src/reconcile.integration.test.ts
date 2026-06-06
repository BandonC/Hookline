import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { endpoints, events } from "@hookline/db";
import { reconcile } from "./index";

// Real D1 (Miniflare) with the production schema applied (test/apply-migrations.ts).
// This exercises reconcile()'s actual WHERE filter — `status = 'pending' AND
// next_attempt_at <= now` — which the mocked reconcile.test.ts can't reach. The
// DO boundary is still faked: the claim under test is *which events the SQL
// selects*, not DO delivery.
function fakeEndpointDo() {
  const poked: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) =>
      ({
        fetch: async () => {
          poked.push((id as unknown as { name: string }).name);
          return new Response(null, { status: 202 });
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
  return { namespace, poked };
}

const db = drizzle(env.DB);

beforeEach(async () => {
  // Explicit clean seed regardless of isolation settings. events first (it
  // references endpoints).
  await env.DB.exec("DELETE FROM events");
  await env.DB.exec("DELETE FROM endpoints");
});

function seedEndpoint(id: string) {
  return db
    .insert(endpoints)
    .values({ id, url: `https://example.test/${id}`, signingSecret: `whsec_${id}`, ingestKey: `ingk_${id}` });
}

function seedEvent(o: {
  id: string;
  endpointId: string;
  status?: "pending" | "delivered" | "failed";
  nextAttemptAt: Date | null;
}) {
  return db.insert(events).values({
    id: o.id,
    endpointId: o.endpointId,
    payload: { hello: "world" },
    status: o.status ?? "pending",
    nextAttemptAt: o.nextAttemptAt,
  });
}

describe("reconcile (real D1)", () => {
  it("pokes exactly the endpoints with past-due pending events", async () => {
    const now = Date.now();
    await seedEndpoint("ep_due");
    await seedEndpoint("ep_future");
    await seedEndpoint("ep_delivered");
    await seedEndpoint("ep_null");

    // past-due pending -> SHOULD be poked
    await seedEvent({ id: "evt_due", endpointId: "ep_due", nextAttemptAt: new Date(now - 60_000) });
    // scheduled in the future -> not due
    await seedEvent({ id: "evt_future", endpointId: "ep_future", nextAttemptAt: new Date(now + 600_000) });
    // already delivered -> not pending
    await seedEvent({ id: "evt_delivered", endpointId: "ep_delivered", status: "delivered", nextAttemptAt: null });
    // pending but unscheduled (null) -> excluded by the <= bound
    await seedEvent({ id: "evt_null", endpointId: "ep_null", nextAttemptAt: null });

    const { namespace, poked } = fakeEndpointDo();
    await reconcile(db, namespace);

    expect(poked).toEqual(["ep_due"]);
  });

  it("pokes nothing on a second run after the event is delivered", async () => {
    const now = Date.now();
    await seedEndpoint("ep_x");
    await seedEvent({ id: "evt_x", endpointId: "ep_x", nextAttemptAt: new Date(now - 60_000) });

    const first = fakeEndpointDo();
    await reconcile(db, first.namespace);
    expect(first.poked).toEqual(["ep_x"]);

    // The DO delivered it: pending -> delivered, schedule cleared.
    await db
      .update(events)
      .set({ status: "delivered", nextAttemptAt: null })
      .where(eq(events.id, "evt_x"));

    const second = fakeEndpointDo();
    await reconcile(db, second.namespace);
    expect(second.poked).toEqual([]);
  });
});
