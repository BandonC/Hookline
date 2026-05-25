import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { endpoints, events, deliveryAttempts } from "@hookline/db";
import type { Endpoint, Event } from "@hookline/db";

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_SNIPPET_CAP = 1024; // 1KB — enforced during the read, never read-then-slice

type Env = { DB: D1Database; ENDPOINT_DO: DurableObjectNamespace };

// Per-endpoint Durable Object: scheduler + delivery worker.
// One instance per endpoint (idFromName(endpointId)). See ./CLAUDE.md for the
// four invariants — do not violate them.
export class EndpointDO {
  constructor(private state: DurableObjectState, private env: Env) {}

  // Poked by the ingestion API / reconciliation cron to schedule a due event.
  // The poke carries this endpoint's id; we persist it so alarm() can scope its
  // D1 query to this endpoint (idFromName is one-way — the DO can't recover the
  // id from state.id). eventId is unused on purpose: alarm() loads due events
  // from D1 (the source of truth), so the poke just sets the time.
  async fetch(req: Request): Promise<Response> {
    const { endpointId, dueAt } = await req.json<{
      eventId: string;
      endpointId: string;
      dueAt: number;
    }>();
    // Idempotent and self-healing: every poke re-asserts the id. The only thing
    // that arms the alarm is this method, so alarm() can never fire without it.
    await this.state.storage.put("endpointId", endpointId);
    const current = await this.state.storage.getAlarm();
    if (current === null || dueAt < current) {
      await this.state.storage.setAlarm(dueAt);
    }
    return new Response(null, { status: 202 });
  }

  // Fires when the soonest scheduled delivery is due. Safe to run twice: the
  // platform may retry alarm() if it throws. Idempotency comes from reloading
  // due `pending` events from D1 on every run — anything already delivered (or
  // parked with a null next_attempt_at) is no longer due, so it isn't reloaded.
  async alarm(): Promise<void> {
    const endpointId = await this.state.storage.get<string>("endpointId");
    if (!endpointId) return; // armed without a poke that stored the id — nothing to scope to

    const db = drizzle(this.env.DB);

    const [endpoint] = await db
      .select()
      .from(endpoints)
      .where(eq(endpoints.id, endpointId))
      .limit(1);
    if (!endpoint) return; // endpoint deleted out from under us — nothing to deliver

    const now = Date.now();
    const due = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.endpointId, endpointId),
          eq(events.status, "pending"),
          lte(events.nextAttemptAt, new Date(now)),
        ),
      );

    for (const event of due) {
      await this.deliver(db, event, endpoint);
    }

    // Re-arm to the soonest still-scheduled pending event, if any remain.
    // Delivered events are no longer pending; failed events were parked with a
    // null next_attempt_at (Step 2 has no backoff), so neither is picked up here.
    const [next] = await db
      .select({ nextAttemptAt: events.nextAttemptAt })
      .from(events)
      .where(
        and(
          eq(events.endpointId, endpointId),
          eq(events.status, "pending"),
          isNotNull(events.nextAttemptAt),
        ),
      )
      .orderBy(asc(events.nextAttemptAt))
      .limit(1);

    if (next?.nextAttemptAt) {
      await this.state.storage.setAlarm(next.nextAttemptAt.getTime());
    }
  }

  // The one method where Invariants 3 and 4 live. Step 2 POSTs UNSIGNED —
  // HMAC signing (Invariant 2) is wired in Step 4; backoff / dead-lettering
  // (Invariant 1) is Step 3. The failure branch here parks the event (clears
  // next_attempt_at, stays pending); Step 3 replaces that with the retry write.
  private async deliver(
    db: ReturnType<typeof drizzle>,
    event: Event,
    endpoint: Endpoint,
  ): Promise<void> {
    const rawBody = JSON.stringify(event.payload);
    const attemptNumber = event.attemptCount + 1;

    let statusCode: number | null = null;
    let snippet: string | null = null;
    const start = Date.now();
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      statusCode = res.status;
      snippet = await readCapped(res, RESPONSE_SNIPPET_CAP); // [Inv. 4]
    } catch (err) {
      // Timeout or network error: the receiver gave us no status. Record the
      // error name only — never the payload or a receiver response body.
      snippet = err instanceof Error ? err.name : "fetch failed";
    }
    const latencyMs = Date.now() - start;

    const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300;

    // [Inv. 3] exactly one attempt row + the event mutation, in ONE batch.
    await db.batch([
      db.insert(deliveryAttempts).values({
        id: `att_${nanoid()}`,
        eventId: event.id,
        attemptNumber,
        statusCode,
        responseSnippet: snippet,
        latencyMs,
      }),
      delivered
        ? db
            .update(events)
            .set({ status: "delivered", nextAttemptAt: null })
            .where(eq(events.id, event.id))
        : db
            .update(events)
            .set({ nextAttemptAt: null }) // park: stay pending, unscheduled (Step 3 adds backoff)
            .where(eq(events.id, event.id)),
    ]);
  }
}

// Invariant 4: read at most `cap` bytes, then stop and cancel. Never buffer the
// whole body — a hostile endpoint streaming GBs must not OOM the Worker.
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    // Stop the stream even if we hit the cap mid-body — a hostile endpoint must
    // not keep streaming into the Worker after we have our snippet.
    await reader.cancel().catch(() => {});
  }

  const buf = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = buf.length - offset;
    if (remaining <= 0) break;
    buf.set(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk, offset);
    offset += Math.min(chunk.length, remaining);
  }
  return new TextDecoder().decode(buf);
}
