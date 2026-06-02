# Hookline

> Reliable webhook delivery service. Applications send it events; it guarantees
> delivery to consumer-registered HTTP endpoints with at-least-once semantics,
> signed payloads, automatic retries, and a dead-letter path for failures.

This document is **context**, not build instructions. It explains what Hookline is,
why it exists, and where it is going. For *how to build it*, read the `CLAUDE.md`
files — the root one for conventions, and the per-package ones for scope-specific rules.

**Status: v1 and v2 are both shipped.** The four v2 features — ordered delivery, fair
scheduling, per-endpoint rate limiting, and circuit-breaking retry — are built, tested,
and deployed. This document keeps the original v1→v2 framing because the *design
rationale* is the point: it shows why each v1 choice left room for v2 rather than
painting it into a corner. The per-package `CLAUDE.md` files remain v1-scoped as the
historical build guides; treat them as the record of how v1 was built, not as a ban on
the v2 code that now exists.

---

## 1. What it is

Hookline sits in the middle of every "Stripe sent your server a `payment.succeeded`
event" interaction — the part that handles signing, retries, failure isolation, and
delivery bookkeeping. An upstream application POSTs an event; Hookline takes
responsibility for delivering it reliably to one or more pre-registered HTTP endpoints
owned by the consumer.

It deliberately occupies the pure backend / distributed-systems lane. The interesting
problems are delivery guarantees, idempotency, retry semantics, ordering, and fair
resource sharing — not UI, not ML, not CRUD.

## 2. Why this project exists

It is the backend / distributed-systems entry in a four-project portfolio. The others
lean applied-AI or frontend; none makes the systems problem itself the headline.
Hookline is recognizable real-world infrastructure, has a clean v1 to v2 depth
progression, and its hard problems map almost perfectly onto its hosting platform's
primitives (Cloudflare Durable Objects).

The portfolio framing matters for one technical decision in particular (see section 8):
delivery scheduling is built in-house from day one rather than leaning on a managed
queue. That keeps the project at $0/month and makes the v2 "I own the scheduler" story
honest, because the scheduler was never outsourced to begin with.

## 3. Delivery semantics

These are the defining decisions; everything else follows from them.

| Property | Choice | Rationale |
| --- | --- | --- |
| Delivery | At-least-once | Exactly-once is impossible over HTTP. Receivers may see duplicates and dedupe on event ID. |
| Ordering (v1) | No guarantee | Ordering is expensive (head-of-line blocking). v1 does not promise it. |
| Ordering (v2) | Opt-in per endpoint | Endpoints may request strict ordering; introduces the ordering-vs-throughput tension. |
| Idempotency | Receiver-side, via event ID | Each event carries a unique ID used as the idempotency key. |
| Authenticity | HMAC-SHA256 + timestamp | Payloads signed so receivers verify origin; timestamp prevents replay. |

## 4. Architecture (v1)

Three logical components, all on Cloudflare:

1. **Ingestion API** — Hono on Cloudflare Workers. Accepts events and endpoint CRUD.
   On `POST /v1/events`: validate, write event to D1 as `pending`, generate an event ID,
   poke the endpoint's Durable Object to schedule delivery, return `202 Accepted`
   immediately. Ingestion never blocks on delivery.

2. **Per-endpoint Durable Object** — the scheduler *and* the delivery worker. Each
   endpoint gets its own DO. It uses the DO **alarm** API to wake at the moment a
   delivery is due, loads the event from D1, signs it, POSTs to the target, records the
   attempt, and on failure re-arms its own alarm with backoff. This is the in-house
   scheduler that replaces a managed queue.

3. **Dashboard** — Next.js on Cloudflare Workers (via OpenNext). Read-only. Lists endpoints, recent
   deliveries, per-event attempt history, and dead-lettered events.

D1 (SQLite) via Drizzle ORM is the source of truth. The DO holds almost no state of its
own in v1 — it is purely a scheduling/delivery mechanism over D1.

### Why Durable Object alarms instead of Cloudflare Queues

Cloudflare Queues requires the Workers Paid plan ($5/mo). DO alarms are on the free
tier. More importantly: Queues' retry delay is not a real configurable
backoff-with-jitter curve, so the backoff has to be computed in code regardless — which
means the "platform handles retries" framing was never fully true. Owning the scheduler
on DO alarms is $0, gives exact (sub-second) retry timing, and is the *same primitive*
v2 is built on, so v2 adds behavior to the DO rather than replacing the v1 plumbing.

## 5. Data model

Cloudflare D1 (SQLite) via Drizzle. The schema file is the single source of truth; see
`packages/db/CLAUDE.md`. v1 shipped four tables; v2 added `tenants` and extended
`endpoints` / `events` with feature columns (the v2 additions are noted below).

| Table | Purpose |
| --- | --- |
| `endpoints` | Registered targets. `id`, `tenant_id` (v2), `url`, `signing_secret`, `description`, `ordered`, `created_at`, plus v2 config columns for rate limiting and the circuit breaker. |
| `events` | Ingested events. `id` (idempotency key), `endpoint_id`, `payload` (JSON), `status` (pending/delivered/failed), `attempt_count`, `next_attempt_at`, `created_at`, plus v2 `ordering_key` and `last_defer_reason`. |
| `delivery_attempts` | One row per attempt. `id`, `event_id`, `attempt_number`, `status_code`, `response_snippet` (capped 1KB), `latency_ms`, `attempted_at`. |
| `dead_letters` | Events that exhausted retries. `event_id`, `failed_at`, `final_error`. |
| `tenants` (v2) | Unit of fairness. `id`, `name`, `weight`, `max_in_flight`, `created_at`. Endpoints belong to one tenant; the coordinator DO meters delivery per tenant. |

## 6. v1 scope (build this)

A complete, usable, end-to-end delivery service someone could actually integrate against.

In scope:
- Endpoint management — create / list / delete, each with an auto-generated HMAC secret.
- Event ingestion — `POST /v1/events`, persisted `pending`, scheduled, `202` returned.
- Delivery via per-endpoint DO alarm — POST to target URL with a timeout.
- Retry with exponential backoff + jitter — decorrelated jitter, computed in code.
- Dead-letter handling — events exhausting retries marked `failed` and surfaced.
- HMAC-SHA256 signing — signed payloads with a timestamp header for replay protection.
- Delivery logging — every attempt recorded.
- Reconciliation cron — low-frequency backstop that re-pokes DOs for stuck `pending` events.
- Minimal read-only dashboard.

Held out of the v1 milestone (now shipped in v2 — see section 7): ordered delivery, fair
scheduling, circuit breaking, per-endpoint rate limiting.

## 7. v2 (shipped)

All four v2 features build on the same per-endpoint Durable Objects v1 already uses (fair
scheduling adds one shared coordinator DO), so v2 adds effectively zero infrastructure and
stays within the free tier.

- **Ordered delivery (centerpiece)** — opt-in `ordered` flag per endpoint, plus an
  `ordering_key` carried on each event. Events sharing `(endpoint, ordering_key)` deliver
  serialized in `created_at` order, one in-flight; different keys deliver in parallel.
  **Consistent hashing maps `(endpoint, ordering_key) → one of K sub-DOs**, so same-key
  events land on the same partition — the algorithm is load-bearing here, not decorative.
  Head-of-line blocking is **per-key**: a stuck event blocks only its own key's queue,
  dead-letters on retry exhaustion (the existing at-least-once path), then the queue
  advances; other keys keep flowing. The exposed tradeoff: per-key throughput is capped at
  one in-flight delivery — chatty keys cap there, the rest of the endpoint doesn't.
- **Fair scheduling** — endpoints belong to **tenants**, and a single coordinator Durable
  Object meters every delivery so one noisy tenant can't exhaust the shared Cloudflare
  subrequest / D1 budget the others depend on. The real starvation risk under per-endpoint
  DOs isn't queue order (DOs are already isolated) — it's shared platform capacity, so the
  fix is **per-tenant in-flight concurrency caps** with **weighted, idle-accruing credits**
  (deficit-round-robin in spirit, applied to slots rather than queue position). Each DO
  acquires a slot before `deliver()` and releases it after; the coordinator fails **open**
  with logging, because at-least-once is sacred and fairness is not.
- **Per-endpoint rate limiting** — token bucket on outbound delivery so Hookline never
  floods a receiver beyond its capacity. Defer-not-drop: a throttled event waits, it is
  never failed for being rate-limited.
- **Circuit-breaking adaptive retry** — per-endpoint closed → open → half-open state
  machine driven by a rolling-window failure rate, replacing fixed-schedule backoff while
  the breaker is open. Shared across an endpoint's bare DO and sub-DOs via D1 CAS.

## 8. Tech stack

Cloudflare-native, TypeScript end-to-end.

| Layer | Tool | Phase |
| --- | --- | --- |
| API routing | Hono on Cloudflare Workers | 1–2 |
| Scheduling + delivery + stateful coordination | Durable Objects (SQLite-backed) | 1–2 |
| Relational store | Cloudflare D1 (SQLite) | 1–2 |
| ORM | Drizzle | 1–2 |
| Payload signing | HMAC-SHA256 (Web Crypto) | 1 |
| Dashboard | Next.js (OpenNext) on Cloudflare Workers | 1–2 |
| CI/CD | GitHub Actions | 1–2 |
| Package mgmt | npm workspaces | 1–2 |

**Cost: $0/month.** Workers, D1, Durable Objects (SQLite class), Workers static assets, and Cron Triggers
all sit within free tiers. No Workers Paid plan required.

## 9. Algorithmic components

Each algorithm is present because the domain requires it.

| Algorithm | Phase | Why |
| --- | --- | --- |
| Decorrelated jitter backoff | v1 | Spreads retries to a recovering endpoint; avoids thundering herd. |
| Consistent hashing | v2 | Maps `(endpoint, ordering_key) → sub-DO` so same-key events stay on the same partition for ordered delivery. |
| Deficit / weighted round-robin | v2 | Fair scheduling across tenants. |
| Token bucket / sliding window | v2 | Per-endpoint outbound rate limiting. |
| Circuit-breaker state machine | v2 | Rolling-window failure tracking to stop hammering failing endpoints. |

Deliberately excluded: a Bloom filter for idempotency dedupe (idempotency keys are
low-volume and need exactness; false positives would harm correctness), and a custom
timing wheel for retry scheduling (the DO alarm already schedules precisely).

## 10. Build order (v1)

1. Schema (D1 + Drizzle), endpoint CRUD, event ingestion (write pending, poke DO).
2. DO `alarm()` + `deliver()` loop — the POST-and-record core.
3. `computeBackoff()` (decorrelated jitter) + re-arm logic + dead-letter on max attempts.
4. HMAC signing wired into `deliver()`.
5. Reconciliation cron + minimal read-only dashboard.
6. Deploy via Wrangler + GitHub Actions; README with architecture diagram.
