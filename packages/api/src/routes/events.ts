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
import { timingSafeEqual } from "../timing-safe-equal";
import { decryptSecret } from "../crypto-secret";

export const events = new Hono<{ Bindings: Bindings }>();

// Hard cap on an ingested event body. Enforced during the read (not via a
// trusted Content-Length) so a chunked or mis-declared stream can't push
// unbounded data into the Worker before we check.
const MAX_BODY_BYTES = 128 * 1024; // 128 KB

// Defensive per-endpoint ingestion cap (token bucket in INGEST_LIMITER). Sized
// generously — a ceiling that bounds a compromised publisher, not a product SLA.
// Tuning these is a deploy, same pattern as MAX_ATTEMPTS / the tenancy constants.
const INGEST_RATE_RPS = 100;
const INGEST_BURST = 200;

events.post("/", async (c) => {
  // Cheap pre-check before any body read or DB work: ingestion requires a
  // bearer token (the endpoint's ingest_key). The endpoint id alone is NOT a
  // credential — it appears in admin listings and the dashboard — so without
  // this gate anyone who learns an id could make Hookline sign+deliver
  // arbitrary payloads under that endpoint's secret. The actual constant-time
  // comparison happens below, once we've loaded the endpoint's key.
  const token = bearerToken(c.req.header("Authorization"));
  if (token === null) throw new HTTPException(401, { message: "unauthorized" });

  const raw = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
  if (raw === null) throw new HTTPException(413, { message: "payload too large" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HTTPException(400, { message: "body must be a JSON object" });
  }
  const body = parsed as Record<string, unknown>;

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
    .select({
      id: endpointsTable.id,
      ordered: endpointsTable.ordered,
      ingestKey: endpointsTable.ingestKey,
    })
    .from(endpointsTable)
    .where(eq(endpointsTable.id, endpointId))
    .limit(1);
  if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });

  // Constant-time compare of the presented token against this endpoint's
  // ingest_key (decrypted from D1; legacy plaintext passes through). Mismatch is
  // 401 — the caller is not authorized to publish here.
  const expectedKey = await decryptSecret(c.env.SECRET_ENCRYPTION_KEY, endpoint.ingestKey);
  if (!timingSafeEqual(token, expectedKey)) {
    throw new HTTPException(401, { message: "unauthorized" });
  }

  // Ordered endpoints require an ordering_key. Accepting one with a sentinel
  // would silently HOLB everything into one queue — see HOOKLINE.md §7.
  if (endpoint.ordered && orderingKey === null) {
    throw new HTTPException(400, {
      message: "ordering_key is required for ordered endpoints",
    });
  }

  // Defensive ingestion rate limit, after auth so only an authorized publisher's
  // own volume is capped (wrong-key callers are already 401'd, cheaply). Checked
  // before the D1 write + DO poke so a flood never reaches them. Keyed by
  // endpoint, matching the ingest_key credential boundary.
  const limiter = c.env.INGEST_LIMITER.get(c.env.INGEST_LIMITER.idFromName(endpointId));
  const limitRes = await limiter.fetch("https://hookline.internal/check", {
    method: "POST",
    body: JSON.stringify({ rate: INGEST_RATE_RPS, burst: INGEST_BURST }),
  });
  const { allowed, retryAfterMs } = await limitRes.json<{
    allowed: boolean;
    retryAfterMs: number;
  }>();
  if (!allowed) {
    return c.json({ error: "rate limited" }, 429, {
      "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
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

// Extract a non-empty bearer token from an Authorization header, or null.
function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length === 0 ? null : token;
}

// Read a request body with a hard byte cap enforced during the read. Returns
// the decoded text, or null if the body exceeds `cap` (the caller maps that to
// 413). Mirrors the DO's readCapped philosophy: never buffer an unbounded body.
async function readBodyCapped(req: Request, cap: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(buf);
}
