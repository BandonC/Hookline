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

  const db = drizzle(c.env.DB);

  const [endpoint] = await db
    .select({ id: endpointsTable.id })
    .from(endpointsTable)
    .where(eq(endpointsTable.id, endpointId))
    .limit(1);
  if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });

  // v1 has no initial delay — the event is due immediately.
  const now = Date.now();
  const eventId = `evt_${nanoid()}`;
  const [row] = await db
    .insert(eventsTable)
    .values({ id: eventId, endpointId, payload, status: "pending", nextAttemptAt: new Date(now) })
    .returning();

  // Poke the endpoint's DO so it arms its alarm. Fire-and-forget: ingestion must
  // not block on delivery, and a lost poke is recovered by the reconciliation
  // cron. Do not log the payload.
  const stub = c.env.ENDPOINT_DO.get(c.env.ENDPOINT_DO.idFromName(endpointId));
  c.executionCtx.waitUntil(
    stub
      .fetch("https://hookline.internal/poke", {
        method: "POST",
        body: JSON.stringify({ eventId, endpointId, dueAt: now }),
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
      next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    },
    202,
  );
});
