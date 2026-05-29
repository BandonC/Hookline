// Event ingestion route handler. Mounted at /v1/events from src/index.ts.
// Flow: validate -> evt_<nanoid> -> write pending + first next_attempt_at
// -> poke endpoint DO -> 202. Never awaits delivery.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { events as eventsTable, endpoints as endpointsTable } from "@hookline/db";
import type { Bindings } from "../bindings";
import { computeShard, endpointDoName } from "../sharding";

export const events = new Hono<{ Bindings: Bindings }>();

events.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HTTPException(400, { message: "body must be a JSON object" });
  }

  const endpointId = body.endpoint_id;
  if (typeof endpointId !== "string" || endpointId.length === 0) {
    throw new HTTPException(400, { message: "endpoint_id is required" });
  }
  const payload = body.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new HTTPException(400, { message: "payload must be a JSON object" });
  }

  // ordering_key is always optional at the type level (nullable column) and is
  // accepted on non-ordered endpoints as a no-op — forward-compatible if the
  // endpoint is later flipped to ordered. When present it must be a non-empty
  // string (the hash input must be deterministic and meaningful).
  const orderingKeyRaw = body.ordering_key;
  let orderingKey: string | null = null;
  if (orderingKeyRaw !== undefined && orderingKeyRaw !== null) {
    if (typeof orderingKeyRaw !== "string" || orderingKeyRaw.length === 0) {
      throw new HTTPException(400, { message: "ordering_key must be a non-empty string" });
    }
    orderingKey = orderingKeyRaw;
  }

  const db = drizzle(c.env.DB);

  const [endpoint] = await db
    .select({ id: endpointsTable.id, ordered: endpointsTable.ordered })
    .from(endpointsTable)
    .where(eq(endpointsTable.id, endpointId))
    .limit(1);
  if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });

  // Ordered endpoints require an ordering_key. Accepting one with a sentinel
  // would silently HOLB everything into one queue — see HOOKLINE.md §7.
  if (endpoint.ordered && orderingKey === null) {
    throw new HTTPException(400, {
      message: "ordering_key is required for ordered endpoints",
    });
  }

  // v1 has no initial delay — the event is due immediately.
  const now = Date.now();
  const eventId = `evt_${nanoid()}`;
  const [row] = await db
    .insert(eventsTable)
    .values({
      id: eventId,
      endpointId,
      payload,
      status: "pending",
      nextAttemptAt: new Date(now),
      orderingKey,
    })
    .returning();

  // Routing is determined by the event row, never by endpoint.ordered: an
  // event with ordering_key=null is owned by the bare DO; an event with
  // ordering_key=X is owned by sub-DO hash(X) % K. The endpoint flag only
  // governs the validation above. This invariant lets ingestion, the cron,
  // and the DO all decide ownership from a row alone, with no flag-flip race.
  const shard = orderingKey === null ? null : await computeShard(orderingKey);
  const doName = endpointDoName(endpointId, shard);

  // Poke the (sub-)DO so it arms its alarm. Fire-and-forget: ingestion must
  // not block on delivery, and a lost poke is recovered by the reconciliation
  // cron. Do not log the payload.
  const stub = c.env.ENDPOINT_DO.get(c.env.ENDPOINT_DO.idFromName(doName));
  c.executionCtx.waitUntil(
    stub
      .fetch("https://hookline.internal/poke", {
        method: "POST",
        body: JSON.stringify({ eventId, endpointId, dueAt: now, shard }),
      })
      .then((r) => {
        if (!r.ok) console.error("DO poke returned non-ok", eventId, r.status);
      })
      .catch((err) => console.error("DO poke failed", eventId, err)),
  );

  return c.json(
    {
      id: row.id,
      endpoint_id: row.endpointId,
      status: row.status,
      ordering_key: row.orderingKey,
      next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    },
    202,
  );
});
