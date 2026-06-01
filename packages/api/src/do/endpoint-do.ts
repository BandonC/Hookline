import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { endpoints, events, deliveryAttempts, deadLetters } from "@hookline/db";
import type { Endpoint, Event } from "@hookline/db";
import { computeBackoff } from "../backoff";
import { signPayload } from "../signing";
import { computeShard } from "../sharding";
import { bucketWindowMs, computeTokens, nextTokenAvailableAt } from "../rate-limit";

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
  // The poke carries this endpoint's id and (for sub-DOs) the shard; we persist
  // both so alarm() can scope its D1 query — idFromName is one-way, so the DO
  // can't recover its name from state.id. eventId is unused on purpose:
  // alarm() loads due events from D1 (the source of truth) so the poke just
  // sets the time.
  //
  // shard is the routing tag (Model C): null = bare DO that owns all events
  // on this endpoint with ordering_key IS NULL; number = sub-DO that owns
  // events whose ordering_key hashes to that shard. The DO's identity is
  // fixed at first poke and never changes — sub-DO names and bare-DO names
  // address different DOs, so a given DO only ever receives pokes for one.
  async fetch(req: Request): Promise<Response> {
    const { endpointId, dueAt, shard } = await req.json<{
      eventId: string;
      endpointId: string;
      dueAt: number;
      shard?: number | null;
    }>();
    // Idempotent and self-healing: every poke re-asserts identity. The only
    // thing that arms the alarm is this method, so alarm() can never fire
    // without it.
    await this.state.storage.put("endpointId", endpointId);
    if (typeof shard === "number") {
      await this.state.storage.put("shard", shard);
    } else {
      await this.state.storage.delete("shard");
    }
    const current = await this.state.storage.getAlarm();
    if (current === null || dueAt < current) {
      await this.state.storage.setAlarm(dueAt);
    }
    return new Response(null, { status: 202 });
  }

  // Fires when the soonest scheduled delivery is due. Safe to run twice: the
  // platform may retry alarm() if it throws. Idempotency comes from reloading
  // pending events from D1 on every run — anything already delivered is no
  // longer pending, so it isn't reloaded.
  //
  // Two paths, chosen by the DO's identity (Model C — see ../sharding.ts):
  //   - Bare DO (shard=undefined): drain ALL due events whose ordering_key
  //     IS NULL. Parallel within the endpoint, no per-key serialization.
  //   - Sub-DO  (shard=number)  : for each ordering_key this shard owns,
  //     deliver ONLY the head (oldest by created_at). Younger same-key events
  //     wait — strict per-key serialization, head-of-line blocking is per-key.
  async alarm(): Promise<void> {
    const endpointId = await this.state.storage.get<string>("endpointId");
    if (!endpointId) return; // armed without a poke that stored the id — nothing to scope to
    const shard = await this.state.storage.get<number>("shard");

    const db = drizzle(this.env.DB);

    const [endpoint] = await db
      .select()
      .from(endpoints)
      .where(eq(endpoints.id, endpointId))
      .limit(1);
    if (!endpoint) return; // endpoint deleted out from under us — nothing to deliver

    if (typeof shard === "number") {
      await alarmOrdered(db, endpoint, shard, this.state.storage);
    } else {
      await alarmUnordered(db, endpoint, this.state.storage);
    }
  }
}

// Bare DO path. Drains every null-key pending event for this endpoint whose
// time has come. The `ordering_key IS NULL` filter is what keeps the bare DO
// from racing with sub-DOs on the same endpoint (Model C invariant): null-key
// events live here, non-null-key events live on sub-DOs.
//
// Rate-limit gate (v2): when configured, the bucket is reconstructed once
// per tick from this DO's recent attempts (its shard scope only). The loop
// consumes tokens locally; when dry, the current event is marked deferred,
// the alarm is moved to the next-token time, and we return without
// delivering. No delivery_attempts row is written on defer.
export async function alarmUnordered(
  db: ReturnType<typeof drizzle>,
  endpoint: Endpoint,
  storage: DurableObjectState["storage"],
): Promise<void> {
  const now = Date.now();
  const due = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.endpointId, endpoint.id),
        isNull(events.orderingKey),
        eq(events.status, "pending"),
        lte(events.nextAttemptAt, new Date(now)),
      ),
    );

  const gate = await loadRateGate(db, endpoint, null, now);

  for (const event of due) {
    if (gate && gate.tokens < 1) {
      await deferForRate(db, storage, event, gate, now);
      return;
    }
    await deliver(db, event, endpoint);
    if (gate) gate.tokens -= 1;
  }

  // Re-arm to the soonest still-scheduled null-key pending event.
  const [next] = await db
    .select({ nextAttemptAt: events.nextAttemptAt })
    .from(events)
    .where(
      and(
        eq(events.endpointId, endpoint.id),
        isNull(events.orderingKey),
        eq(events.status, "pending"),
        isNotNull(events.nextAttemptAt),
      ),
    )
    .orderBy(asc(events.nextAttemptAt))
    .limit(1);

  if (next?.nextAttemptAt) {
    await storage.setAlarm(next.nextAttemptAt.getTime());
  }
}

// Sub-DO path. For each ordering_key on this endpoint that hashes to our shard,
// deliver only the head (oldest by created_at) — and only if its next_attempt_at
// is due. Younger events in the same key wait; we never skip a retrying head.
// This is what makes head-of-line blocking strictly per-key.
//
// We load all non-null-key pending events for the endpoint and filter to our
// shard in code (SQLite can't compute SHA-256 in-query). At v1 scale this is
// bounded by the endpoint's pending queue depth; if it ever becomes a hot
// path, the next move is to denormalize `shard` onto events and index it —
// don't pre-build that.
//
// Within a sub-DO, owned-key deliveries run sequentially. Different keys on
// different sub-DOs run in parallel by virtue of being different DOs. Same-
// shard different-key deliveries serialize at the sub-DO; that's the known
// cost of finite K, not a correctness issue.
export async function alarmOrdered(
  db: ReturnType<typeof drizzle>,
  endpoint: Endpoint,
  shard: number,
  storage: DurableObjectState["storage"],
): Promise<void> {
  const now = Date.now();

  // Rate-limit gate is the SECOND gate, after due+owned: a head we own and
  // that's due may still be declined if this sub-DO's bucket is dry. Same
  // per-shard isolation as the bare path — sub-DOs each replay only their
  // own attempts.
  const gate = await loadRateGate(db, endpoint, shard, now);

  for (const head of await ownedHeads(db, endpoint.id, shard)) {
    if (!head.nextAttemptAt) continue; // pending implies scheduled; defensive
    if (head.nextAttemptAt.getTime() > now) continue; // head not yet due — wait, don't skip
    if (gate && gate.tokens < 1) {
      await deferForRate(db, storage, head, gate, now);
      return;
    }
    await deliver(db, head, endpoint);
    if (gate) gate.tokens -= 1;
  }

  // Re-arm to the soonest still-pending owned head. Deliveries above may have
  // marked heads delivered/failed, advanced keys to a new head, or pushed the
  // same head's next_attempt_at into the future — so we re-query.
  let soonest: number | null = null;
  for (const head of await ownedHeads(db, endpoint.id, shard)) {
    if (!head.nextAttemptAt) continue;
    const t = head.nextAttemptAt.getTime();
    soonest = soonest === null ? t : Math.min(soonest, t);
  }
  if (soonest !== null) {
    await storage.setAlarm(soonest);
  }
}

// Per-key heads owned by `shard` on this endpoint. The first row per key in a
// created_at-ordered scan IS that key's head, so we group as we iterate.
// Exported for tests — this is the function HOLB correctness rides on.
export async function ownedHeads(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  shard: number,
): Promise<Event[]> {
  const pending = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.endpointId, endpointId),
        isNotNull(events.orderingKey),
        eq(events.status, "pending"),
      ),
    )
    .orderBy(asc(events.createdAt));

  const heads = new Map<string, Event>();
  for (const e of pending) {
    const key = e.orderingKey!;
    if (heads.has(key)) continue;
    heads.set(key, e);
  }

  const owned: Event[] = [];
  for (const [key, head] of heads) {
    if ((await computeShard(key)) === shard) owned.push(head);
  }
  return owned;
}

// The one place Invariants 1, 2, 3 and 4 meet. Signs the envelope and POSTs it
// (Inv. 2); on failure decides: under MAX_ATTEMPTS → retry on the decorrelated-
// jitter curve (Inv. 1); at MAX_ATTEMPTS → mark failed + dead-letter, never a
// silent drop. Each branch writes exactly one attempt row in one batch (Inv. 3).
// It touches no DO state — pure (db, event, endpoint) → effects — which is why
// it lives at module scope and is unit-tested directly rather than through the DO.
export async function deliver(
  db: ReturnType<typeof drizzle>,
  event: Event,
  endpoint: Endpoint,
): Promise<void> {
  // [Inv. 2/5] Sign an envelope that carries the event id, so the id is inside
  // the signed body — not merely an unsigned header. signPayload signs
  // `${timestamp}.${rawBody}`; we compute rawBody once and POST those exact
  // bytes, so what we signed is byte-for-byte what the receiver verifies.
  const rawBody = JSON.stringify({ id: event.id, payload: event.payload });
  const attemptNumber = event.attemptCount + 1;

  // Fresh per attempt (unix seconds, the Stripe construction): a retry re-signs
  // with a new timestamp, so the receiver's replay window is measured from the
  // actual send, not the original ingestion.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(endpoint.signingSecret, rawBody, timestamp);

  let statusCode: number | null = null;
  let snippet: string | null = null;
  const start = Date.now();
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hookline-Timestamp": String(timestamp),
        "X-Hookline-Signature": signature,
        // Convenience only. Authority is the id inside the signed body, never
        // this header (Invariant 2) — don't let a receiver trust it for identity.
        "X-Hookline-Event-Id": event.id,
      },
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

  // [Inv. 3] The attempt row is always the first statement; the event mutation
  // (and, on exhaustion, the dead-letter insert) ride in the SAME batch.
  // attemptedAt is set explicitly (not via the schema default) because the
  // default `unixepoch() * 1000` truncates to whole seconds — the rate-limit
  // bucket replay in rate-limit.ts needs ms precision to compute refill
  // intervals accurately at higher rps values.
  const attemptInsert = db.insert(deliveryAttempts).values({
    id: `att_${nanoid()}`,
    eventId: event.id,
    attemptNumber,
    statusCode,
    responseSnippet: snippet,
    latencyMs,
    attemptedAt: new Date(start),
  });

  if (delivered) {
    await db.batch([
      attemptInsert,
      db
        .update(events)
        .set({ status: "delivered", nextAttemptAt: null, lastDeferReason: null })
        .where(eq(events.id, event.id)),
    ]);
    return;
  }

  if (attemptNumber >= MAX_ATTEMPTS) {
    // Retries exhausted: mark failed, clear the schedule, and dead-letter in
    // one batch. Never a silent drop (Invariant 1 / project invariant 1).
    // final_error stays bounded: last status code, or the network error name
    // — never the payload or a receiver response body.
    const finalError =
      statusCode !== null ? `HTTP ${statusCode}` : (snippet ?? "fetch failed");
    await db.batch([
      attemptInsert,
      db
        .update(events)
        .set({
          status: "failed",
          nextAttemptAt: null,
          attemptCount: attemptNumber,
          lastDeferReason: null,
        })
        .where(eq(events.id, event.id)),
      db.insert(deadLetters).values({ eventId: event.id, finalError }),
    ]);
    return;
  }

  // Failed, under max: schedule the next attempt on the decorrelated-jitter
  // curve (Invariant 1). lastDelayMs is the stateful `prev`; persisting it lets
  // the next retry continue the random walk. alarm()'s existing re-arm picks
  // this up — the event stays pending with a future next_attempt_at.
  const delay = Math.round(computeBackoff(event.lastDelayMs));
  await db.batch([
    attemptInsert,
    db
      .update(events)
      .set({
        attemptCount: attemptNumber,
        nextAttemptAt: new Date(Date.now() + delay),
        lastDelayMs: delay,
        // Cleared on every attempt — last_defer_reason reflects the most
        // recent scheduling decision, which here is "actually attempted."
        lastDeferReason: null,
      })
      .where(eq(events.id, event.id)),
  ]);
}

// Rate-limit gate state for one alarm tick. `tokens` is reconstructed from the
// recent attempt history scoped to this DO's shard, and mutated locally as
// the loop consumes. Null when the endpoint has no rate config — the gate is
// then skipped entirely (today's unlimited behavior).
type RateGate = { tokens: number; rate: number; burst: number };

async function loadRateGate(
  db: ReturnType<typeof drizzle>,
  endpoint: Endpoint,
  shard: number | null,
  now: number,
): Promise<RateGate | null> {
  const rate = endpoint.rateLimitRps;
  const burst = endpoint.rateLimitBurst;
  if (rate === null || burst === null) return null;

  // Query is bounded by the bucket window (burst/rate sec) and uses the
  // (event_id, attempted_at) composite index for both the FK join and the
  // time filter. Shard membership can't be expressed in SQL (SHA-256 isn't
  // a SQLite function), so we filter null vs non-null in the WHERE and
  // recompute per-key shard in code.
  const windowStart = new Date(now - bucketWindowMs(rate, burst));
  const rows = await db
    .select({
      attemptedAt: deliveryAttempts.attemptedAt,
      orderingKey: events.orderingKey,
    })
    .from(deliveryAttempts)
    .innerJoin(events, eq(deliveryAttempts.eventId, events.id))
    .where(
      and(
        eq(events.endpointId, endpoint.id),
        gte(deliveryAttempts.attemptedAt, windowStart),
        shard === null ? isNull(events.orderingKey) : isNotNull(events.orderingKey),
      ),
    );

  const timestamps: number[] = [];
  for (const r of rows) {
    if (shard === null) {
      // WHERE already restricted to null-key; nothing more to do.
      timestamps.push(r.attemptedAt.getTime());
    } else if (r.orderingKey !== null && (await computeShard(r.orderingKey)) === shard) {
      timestamps.push(r.attemptedAt.getTime());
    }
  }
  timestamps.sort((a, b) => a - b);

  return { tokens: computeTokens(timestamps, rate, burst, now), rate, burst };
}

// Defer path: the bucket is dry for `event`. Mark it deferred (b1 — the
// most recent scheduling decision is the rate-limit gate), set the alarm
// to the next-token time, and return without writing a delivery_attempts
// row. No event status, attempt_count, or next_attempt_at is touched —
// the event stays exactly as it was, just with last_defer_reason set.
async function deferForRate(
  db: ReturnType<typeof drizzle>,
  storage: DurableObjectState["storage"],
  event: Event,
  gate: RateGate,
  now: number,
): Promise<void> {
  await db
    .update(events)
    .set({ lastDeferReason: "rate_limited" })
    .where(eq(events.id, event.id));
  await storage.setAlarm(nextTokenAvailableAt(gate.tokens, gate.rate, now));
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
