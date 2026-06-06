import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { endpoints, events, tenants, deliveryAttempts, deadLetters } from "@hookline/db";
import type { Endpoint, Event, Tenant } from "@hookline/db";
import { computeBackoff } from "../backoff";
import { signPayload } from "../signing";
import { decryptSecret } from "../crypto-secret";
import { computeShard } from "../sharding";
import { bucketWindowMs, computeTokens, nextTokenAvailableAt } from "../rate-limit";
import {
  failureRate,
  shouldTrip,
  isSuccessStatus,
  BREAKER_WINDOW_MS,
  BREAKER_MIN_SAMPLES,
  BREAKER_OPEN_SEC_DEFAULT,
  BREAKER_THRESHOLD_PCT_DEFAULT,
  type AttemptSample,
} from "../circuit-breaker";
import { makeSchedulerClient, type SchedulerClient } from "../scheduler-client";

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_SNIPPET_CAP = 1024; // 1KB — enforced during the read, never read-then-slice

type Env = {
  DB: D1Database;
  ENDPOINT_DO: DurableObjectNamespace;
  // v2 fair scheduling. The DO calls this before every deliver() and
  // releases after — see scheduler-client.ts.
  SCHEDULER_DO: DurableObjectNamespace;
  // Master key for decrypting the endpoint's signing_secret before signing a
  // delivery. See crypto-secret.ts.
  SECRET_ENCRYPTION_KEY: string;
};

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

    // v2 fair scheduling: every endpoint belongs to exactly one tenant
    // (non-null FK, app-level validated at POST /v1/endpoints). The tenant
    // row carries weight + max_in_flight which the coordinator needs to
    // make per-tenant decisions; we pass them in on every acquire so the
    // coordinator never touches D1.
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, endpoint.tenantId))
      .limit(1);
    if (!tenant) {
      // Impossible by construction (tenant delete is refused while
      // endpoints reference it). Log and bail — fail-open on a missing
      // tenant would imply unknown fairness state, which is worse than
      // a delayed delivery the reconciliation cron will eventually retry.
      console.error("alarm: tenant missing for endpoint", endpoint.id, endpoint.tenantId);
      return;
    }

    const scheduler = makeSchedulerClient(this.env.SCHEDULER_DO);

    // Decrypt the signing secret once here (the DO is the only place with the
    // master key), and hand the delivery path an endpoint carrying the plaintext
    // secret. Everything downstream — alarmUnordered/Ordered, deliver() — reads
    // endpoint.signingSecret unchanged. Legacy plaintext rows pass through.
    const signingSecret = await decryptSecret(this.env.SECRET_ENCRYPTION_KEY, endpoint.signingSecret);
    const endpointForDelivery: Endpoint = { ...endpoint, signingSecret };

    if (typeof shard === "number") {
      await alarmOrdered(db, endpointForDelivery, tenant, scheduler, shard, this.state.storage);
    } else {
      await alarmUnordered(db, endpointForDelivery, tenant, scheduler, this.state.storage);
    }
  }
}

// Bare DO path. Drains every null-key pending event for this endpoint whose
// time has come. The `ordering_key IS NULL` filter is what keeps the bare DO
// from racing with sub-DOs on the same endpoint (Model C invariant): null-key
// events live here, non-null-key events live on sub-DOs.
//
// Gate order: breaker → due+owned → rate-limit → tenant slot. Breaker is
// per-endpoint state; rate-limit bucket is per-shard; tenant slot is
// cross-tenant (coordinator DO). No delivery_attempts row is written on
// a defer of any kind.
export async function alarmUnordered(
  db: ReturnType<typeof drizzle>,
  endpoint: Endpoint,
  tenant: Tenant,
  scheduler: SchedulerClient,
  storage: DurableObjectState["storage"],
): Promise<void> {
  const now = Date.now();
  const breaker = await loadBreakerGate(db, endpoint, now);

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

  // Breaker deferAll: every due event becomes a breaker_open defer, alarm
  // re-arms to the next breaker re-evaluation time. No delivery happens.
  if (breaker.kind === "deferAll") {
    for (const event of due) {
      await setBreakerDefer(db, event.id);
    }
    if (due.length > 0) await storage.setAlarm(breaker.reArmTo);
    return;
  }

  // Breaker trial: this DO won the open→half_open CAS. Deliver exactly one
  // event, then CAS based on outcome. If we have no work, option (a):
  // CAS back to open with a fresh open_until so the next half-open attempt
  // happens after another full open cycle.
  if (breaker.kind === "trial") {
    if (due.length === 0) {
      await tryCasHalfOpenToOpen(db, endpoint.id, now, breaker.openMs);
      return; // no work to re-arm to
    }
    const trial = due[0]!;
    // Tenant gate still applies to the trial: it's a real outbound delivery
    // and consumes the same shared capacity. If denied, release the
    // half-open lock so another tick can retry once capacity frees,
    // mark the event tenant_throttled, and re-arm to the retry hint.
    const trialAck = await scheduler.acquire({
      tenantId: tenant.id,
      weight: tenant.weight,
      maxInFlight: tenant.maxInFlight,
      endpointId: endpoint.id,
      eventId: trial.id,
    });
    if (!trialAck.granted) {
      await tryCasHalfOpenToOpen(db, endpoint.id, now, breaker.openMs);
      await deferForTenantThrottle(db, storage, trial, trialAck.retryAfterMs, now);
      return;
    }
    let delivered = false;
    try {
      ({ delivered } = await deliver(db, trial, endpoint));
    } finally {
      await scheduler.release({
        slotToken: trialAck.slotToken,
        outcome: delivered ? "delivered" : "failed",
      });
    }
    if (delivered) {
      await tryCasHalfOpenToClosed(db, endpoint.id);
    } else {
      await tryCasHalfOpenToOpen(db, endpoint.id, Date.now(), breaker.openMs);
    }
    // Re-arm to soonest still-pending null-key event; subsequent ticks handle
    // the rest under the post-trial state (closed = deliver, open = defer).
    await reArmUnordered(db, endpoint.id, storage);
    return;
  }

  // Breaker closed (or disabled). Run the normal loop with rate-limit gate
  // and a mid-loop trip check that observes the trial's outcome by tracking
  // samples locally — no extra SQL per delivery.
  const gate = await loadRateGate(db, endpoint, null, now);
  const breakerSamples: AttemptSample[] = breaker.kind === "closed" ? [...breaker.samples] : [];
  let breakerTripped = false;
  let tripReArmTo: number | null = null;

  for (const event of due) {
    if (breakerTripped) {
      await setBreakerDefer(db, event.id);
      continue;
    }
    if (gate && gate.tokens < 1) {
      await deferForRate(db, storage, event, gate, now);
      return;
    }
    // Tenant slot gate (after rate-limit, before deliver). Same shape as
    // the rate-limit defer: every remaining event in this loop belongs to
    // the same tenant on the same DO, so a deny here will deny them all —
    // mark THIS event and abort the loop.
    const ack = await scheduler.acquire({
      tenantId: tenant.id,
      weight: tenant.weight,
      maxInFlight: tenant.maxInFlight,
      endpointId: endpoint.id,
      eventId: event.id,
    });
    if (!ack.granted) {
      await deferForTenantThrottle(db, storage, event, ack.retryAfterMs, Date.now());
      return;
    }

    let delivered = false;
    try {
      ({ delivered } = await deliver(db, event, endpoint));
      if (gate) gate.tokens -= 1;

      if (breaker.kind === "closed") {
        const obsNow = Date.now();
        breakerSamples.push({ attemptedAt: obsNow, success: delivered });
        const { rate, count } = failureRate(breakerSamples, BREAKER_WINDOW_MS, obsNow);
        if (shouldTrip(rate, count, BREAKER_MIN_SAMPLES, breaker.thresholdPct)) {
          await tryCasClosedToOpen(db, endpoint.id, obsNow, breaker.openMs);
          // Whether we won or lost the CAS, the breaker is now open from
          // this DO's perspective — defer the remaining due events.
          breakerTripped = true;
          tripReArmTo = obsNow + breaker.openMs;
        }
      }
    } finally {
      await scheduler.release({
        slotToken: ack.slotToken,
        outcome: delivered ? "delivered" : "failed",
      });
    }
  }

  if (breakerTripped && tripReArmTo !== null) {
    await storage.setAlarm(tripReArmTo);
    return;
  }
  await reArmUnordered(db, endpoint.id, storage);
}

// Re-arm to the soonest still-scheduled null-key pending event for this
// endpoint. Extracted because both the trial path and the normal-loop path
// need the same wake-up.
async function reArmUnordered(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  storage: DurableObjectState["storage"],
): Promise<void> {
  const [next] = await db
    .select({ nextAttemptAt: events.nextAttemptAt })
    .from(events)
    .where(
      and(
        eq(events.endpointId, endpointId),
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
  tenant: Tenant,
  scheduler: SchedulerClient,
  shard: number,
  storage: DurableObjectState["storage"],
): Promise<void> {
  const now = Date.now();
  const breaker = await loadBreakerGate(db, endpoint, now);

  // Compute owned, due heads up front: the breaker defer/trial paths need
  // the same answer the normal loop does. ownedHeads filters by shard;
  // here we additionally filter by due time so the trial picks an actually-
  // ready head (a head whose next_attempt_at is in the future would
  // otherwise be "delivered early" by the trial path).
  const ownedDueHeads: Event[] = [];
  for (const head of await ownedHeads(db, endpoint.id, shard)) {
    if (!head.nextAttemptAt) continue;
    if (head.nextAttemptAt.getTime() > now) continue;
    ownedDueHeads.push(head);
  }

  if (breaker.kind === "deferAll") {
    for (const head of ownedDueHeads) {
      await setBreakerDefer(db, head.id);
    }
    if (ownedDueHeads.length > 0) await storage.setAlarm(breaker.reArmTo);
    return;
  }

  if (breaker.kind === "trial") {
    if (ownedDueHeads.length === 0) {
      await tryCasHalfOpenToOpen(db, endpoint.id, now, breaker.openMs);
      return;
    }
    const trial = ownedDueHeads[0]!;
    const trialAck = await scheduler.acquire({
      tenantId: tenant.id,
      weight: tenant.weight,
      maxInFlight: tenant.maxInFlight,
      endpointId: endpoint.id,
      eventId: trial.id,
    });
    if (!trialAck.granted) {
      await tryCasHalfOpenToOpen(db, endpoint.id, now, breaker.openMs);
      await deferForTenantThrottle(db, storage, trial, trialAck.retryAfterMs, now);
      return;
    }
    let delivered = false;
    try {
      ({ delivered } = await deliver(db, trial, endpoint));
    } finally {
      await scheduler.release({
        slotToken: trialAck.slotToken,
        outcome: delivered ? "delivered" : "failed",
      });
    }
    if (delivered) {
      await tryCasHalfOpenToClosed(db, endpoint.id);
    } else {
      await tryCasHalfOpenToOpen(db, endpoint.id, Date.now(), breaker.openMs);
    }
    await reArmOrdered(db, endpoint.id, shard, storage);
    return;
  }

  // Breaker closed (or disabled). Normal loop with rate-limit gate + mid-loop
  // trip check.
  const gate = await loadRateGate(db, endpoint, shard, now);
  const breakerSamples: AttemptSample[] = breaker.kind === "closed" ? [...breaker.samples] : [];
  let breakerTripped = false;
  let tripReArmTo: number | null = null;

  for (const head of ownedDueHeads) {
    if (breakerTripped) {
      await setBreakerDefer(db, head.id);
      continue;
    }
    if (gate && gate.tokens < 1) {
      await deferForRate(db, storage, head, gate, now);
      return;
    }
    const ack = await scheduler.acquire({
      tenantId: tenant.id,
      weight: tenant.weight,
      maxInFlight: tenant.maxInFlight,
      endpointId: endpoint.id,
      eventId: head.id,
    });
    if (!ack.granted) {
      await deferForTenantThrottle(db, storage, head, ack.retryAfterMs, Date.now());
      return;
    }

    let delivered = false;
    try {
      ({ delivered } = await deliver(db, head, endpoint));
      if (gate) gate.tokens -= 1;

      if (breaker.kind === "closed") {
        const obsNow = Date.now();
        breakerSamples.push({ attemptedAt: obsNow, success: delivered });
        const { rate, count } = failureRate(breakerSamples, BREAKER_WINDOW_MS, obsNow);
        if (shouldTrip(rate, count, BREAKER_MIN_SAMPLES, breaker.thresholdPct)) {
          await tryCasClosedToOpen(db, endpoint.id, obsNow, breaker.openMs);
          breakerTripped = true;
          tripReArmTo = obsNow + breaker.openMs;
        }
      }
    } finally {
      await scheduler.release({
        slotToken: ack.slotToken,
        outcome: delivered ? "delivered" : "failed",
      });
    }
  }

  if (breakerTripped && tripReArmTo !== null) {
    await storage.setAlarm(tripReArmTo);
    return;
  }
  await reArmOrdered(db, endpoint.id, shard, storage);
}

// Re-arm to the soonest still-pending owned head on this shard. Deliveries
// may have marked heads delivered/failed, advanced keys to a new head, or
// pushed the same head's next_attempt_at into the future — re-query.
async function reArmOrdered(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  shard: number,
  storage: DurableObjectState["storage"],
): Promise<void> {
  let soonest: number | null = null;
  for (const head of await ownedHeads(db, endpointId, shard)) {
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
): Promise<{ delivered: boolean }> {
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
    return { delivered: true };
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
    return { delivered: false };
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
  return { delivered: false };
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

// Defer path: the coordinator denied a slot for this event's tenant.
// Same shape as deferForRate/setBreakerDefer — set the reason, leave
// status/attempt_count/next_attempt_at untouched, no delivery_attempts
// row. Re-arm to the coordinator's retry hint; the per-endpoint DO
// returns immediately, so the rest of this tick's due events (all
// belonging to the same tenant) wait until the next alarm.
async function deferForTenantThrottle(
  db: ReturnType<typeof drizzle>,
  storage: DurableObjectState["storage"],
  event: Event,
  retryAfterMs: number,
  now: number,
): Promise<void> {
  await db
    .update(events)
    .set({ lastDeferReason: "tenant_throttled" })
    .where(eq(events.id, event.id));
  await storage.setAlarm(now + retryAfterMs);
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

// ============================================================================
// Circuit breaker — runs as the FIRST gate, ahead of due+owned and rate limit.
// State (closed/open/half_open + open_until) is persisted on the endpoint row
// because it must be shared across the bare DO + K sub-DOs (Decision C).
// Transitions use D1 CAS (UPDATE ... WHERE id=? AND breaker_state=?) so only
// one DO ever wins a given transition.
// ============================================================================

// A breaker verdict tells the alarm path exactly what to do this tick:
//   - "skip":     breaker is disabled — proceed as if it didn't exist.
//   - "closed":   proceed; observe samples; if shouldTrip mid-loop, CAS open.
//   - "deferAll": breaker is open (or another DO holds the half-open trial).
//                 Every due event becomes a breaker_open defer.
//   - "trial":    THIS DO won the open→half_open CAS. Deliver exactly ONE
//                 event, then CAS to closed (success) or open (failure).
type BreakerVerdict =
  | { kind: "skip" }
  | { kind: "closed"; samples: AttemptSample[]; thresholdPct: number; openMs: number }
  | { kind: "deferAll"; reArmTo: number }
  | { kind: "trial"; openMs: number };

// Resolve the per-endpoint tunables to concrete numbers (column null = default).
function resolveBreakerKnobs(endpoint: Endpoint): { openMs: number; thresholdPct: number } {
  return {
    openMs: (endpoint.breakerOpenSec ?? BREAKER_OPEN_SEC_DEFAULT) * 1000,
    thresholdPct: endpoint.breakerThresholdPct ?? BREAKER_THRESHOLD_PCT_DEFAULT,
  };
}

// Per-endpoint failure samples in the rolling window. Scoped to ALL attempts
// on this endpoint, regardless of shard — circuit state is per-endpoint, not
// per-shard (Decision C). The window is bounded (30s), so the result set is
// small even on busy endpoints.
async function loadBreakerSamples(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  now: number,
): Promise<AttemptSample[]> {
  const cutoff = new Date(now - BREAKER_WINDOW_MS);
  const rows = await db
    .select({
      attemptedAt: deliveryAttempts.attemptedAt,
      statusCode: deliveryAttempts.statusCode,
    })
    .from(deliveryAttempts)
    .innerJoin(events, eq(deliveryAttempts.eventId, events.id))
    .where(
      and(
        eq(events.endpointId, endpointId),
        gte(deliveryAttempts.attemptedAt, cutoff),
      ),
    );
  return rows.map((r) => ({
    attemptedAt: r.attemptedAt.getTime(),
    success: isSuccessStatus(r.statusCode),
  }));
}

// Decide what the alarm tick may do, based on the current persisted breaker
// state and (for closed state) the recent attempt history. May perform a CAS
// to claim the half-open trial slot. Idempotent on retry: a CAS that
// previously succeeded looks like "already half_open" on the second run,
// which falls through to deferAll — safe.
async function loadBreakerGate(
  db: ReturnType<typeof drizzle>,
  endpoint: Endpoint,
  now: number,
): Promise<BreakerVerdict> {
  if (!endpoint.circuitBreakerEnabled) return { kind: "skip" };
  const { openMs, thresholdPct } = resolveBreakerKnobs(endpoint);

  if (endpoint.breakerState === "closed") {
    const samples = await loadBreakerSamples(db, endpoint.id, now);
    return { kind: "closed", samples, thresholdPct, openMs };
  }

  if (endpoint.breakerState === "open") {
    const openUntilMs = endpoint.breakerOpenUntil?.getTime() ?? now;
    if (now < openUntilMs) {
      return { kind: "deferAll", reArmTo: openUntilMs };
    }
    // Time to test the receiver. Race with K other DOs for the trial slot.
    const won = await tryCasOpenToHalfOpen(db, endpoint.id);
    if (won) return { kind: "trial", openMs };
    // Lost the race — someone else owns the trial. Wait one full open-cycle
    // as a pessimistic fallback (assumes the trial fails). If the trial
    // succeeds, the next tick sees state=closed and proceeds normally.
    return { kind: "deferAll", reArmTo: now + openMs };
  }

  // state === "half_open" and we didn't transition this tick → another DO
  // is mid-trial. Same wait-out as the lost-CAS case above.
  return { kind: "deferAll", reArmTo: now + openMs };
}

// CAS helpers. Each returns true iff the UPDATE actually changed a row.
// D1's `db.run()` exposes `meta.changes`; for drizzle-d1 the .returning()
// row count tells us the same thing in a type-safe way.
async function tryCasState(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  fromState: "closed" | "open" | "half_open",
  patch: {
    breakerState: "closed" | "open" | "half_open";
    breakerOpenedAt?: Date | null;
    breakerOpenUntil?: Date | null;
  },
): Promise<boolean> {
  const rows = await db
    .update(endpoints)
    .set(patch)
    .where(and(eq(endpoints.id, endpointId), eq(endpoints.breakerState, fromState)))
    .returning({ id: endpoints.id });
  return rows.length === 1;
}

async function tryCasClosedToOpen(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  now: number,
  openMs: number,
): Promise<boolean> {
  return tryCasState(db, endpointId, "closed", {
    breakerState: "open",
    breakerOpenedAt: new Date(now),
    breakerOpenUntil: new Date(now + openMs),
  });
}

async function tryCasOpenToHalfOpen(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
): Promise<boolean> {
  // opened_at / open_until stay frozen at the prior open's values during the
  // trial — useful for the dashboard "open since X" display.
  return tryCasState(db, endpointId, "open", { breakerState: "half_open" });
}

async function tryCasHalfOpenToClosed(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
): Promise<boolean> {
  return tryCasState(db, endpointId, "half_open", {
    breakerState: "closed",
    breakerOpenedAt: null,
    breakerOpenUntil: null,
  });
}

async function tryCasHalfOpenToOpen(
  db: ReturnType<typeof drizzle>,
  endpointId: string,
  now: number,
  openMs: number,
): Promise<boolean> {
  // Either a failed trial OR the "no-work-on-trial" fallback (option a).
  // opened_at is refreshed because conceptually this is a new open period.
  return tryCasState(db, endpointId, "half_open", {
    breakerState: "open",
    breakerOpenedAt: new Date(now),
    breakerOpenUntil: new Date(now + openMs),
  });
}

// Defer path: breaker says no. Same shape as deferForRate — set the reason,
// leave status / attempt_count / next_attempt_at untouched. The event will
// re-fire when alarm() is poked or re-arms.
async function setBreakerDefer(
  db: ReturnType<typeof drizzle>,
  eventId: string,
): Promise<void> {
  await db
    .update(events)
    .set({ lastDeferReason: "breaker_open" })
    .where(eq(events.id, eventId));
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
