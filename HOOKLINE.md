# Hookline

> Reliable webhook delivery service. Applications send it events; it guarantees
> delivery to consumer-registered HTTP endpoints with at-least-once semantics,
> signed payloads, automatic retries, and a dead-letter path for failures.

This document is **context**, not build instructions. It explains what Hookline is,
why it exists, and where it is going. For *how to build it*, read the `CLAUDE.md`
files — the root one for conventions, and the per-package ones for scope-specific rules.

The build-instruction files (`CLAUDE.md`) are **v1-only on purpose**. This document
includes v2 so the design intent is visible and v1 choices don't paint v2 into a
corner — but nothing in v2 should be scaffolded until v1 ships.

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

3. **Dashboard** — Next.js on Cloudflare Pages. Read-only. Lists endpoints, recent
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

Cloudflare D1 (SQLite) via Drizzle. Four tables. The schema file is the single source of
truth; see `packages/db/CLAUDE.md`.

| Table | Purpose |
| --- | --- |
| `endpoints` | Registered targets. `id`, `url`, `signing_secret`, `description`, `ordered` (bool, present for v2 but unused in v1), `created_at`. |
| `events` | Ingested events. `id` (idempotency key), `endpoint_id`, `payload` (JSON), `status` (pending/delivered/failed), `attempt_count`, `next_attempt_at`, `created_at`. |
| `delivery_attempts` | One row per attempt. `id`, `event_id`, `attempt_number`, `status_code`, `response_snippet` (capped 1KB), `latency_ms`, `attempted_at`. |
| `dead_letters` | Events that exhausted retries. `event_id`, `failed_at`, `final_error`. |

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

Explicitly out of v1 (see section 7): ordered delivery, fair scheduling, circuit
breaking, per-endpoint rate limiting. Documented as planned; not built.

## 7. v2 vision (DO NOT build yet — context only)

All four v2 features live on the same per-endpoint Durable Objects v1 already uses, so
v2 adds zero infrastructure and zero cost.

- **Ordered delivery (centerpiece)** — opt-in `ordered` flag. The endpoint's DO
  serializes delivery to one in-flight at a time, surfacing head-of-line blocking and
  the ordering-vs-throughput tradeoff. Consistent hashing pins an endpoint's events to a
  stable partition.
- **Fair scheduling** — deficit / weighted round-robin across tenants plus per-tenant
  credits, so one noisy tenant can't starve others.
- **Per-endpoint rate limiting** — token bucket / sliding window on outbound delivery so
  Hookline never floods a receiver beyond its capacity.
- **Circuit-breaking adaptive retry** — per-endpoint closed to open to half-open state
  machine driven by a rolling-window failure rate, replacing fixed-schedule backoff.

## 8. Tech stack

Cloudflare-native, TypeScript end-to-end.

| Layer | Tool | Phase |
| --- | --- | --- |
| API routing | Hono on Cloudflare Workers | 1–2 |
| Scheduling + delivery + stateful coordination | Durable Objects (SQLite-backed) | 1–2 |
| Relational store | Cloudflare D1 (SQLite) | 1–2 |
| ORM | Drizzle | 1–2 |
| Payload signing | HMAC-SHA256 (Web Crypto) | 1 |
| Dashboard | Next.js on Cloudflare Pages | 1–2 |
| CI/CD | GitHub Actions | 1–2 |
| Package mgmt | npm workspaces | 1–2 |

**Cost: $0/month.** Workers, D1, Durable Objects (SQLite class), Pages, and Cron Triggers
all sit within free tiers. No Workers Paid plan required.

## 9. Algorithmic components

Each algorithm is present because the domain requires it.

| Algorithm | Phase | Why |
| --- | --- | --- |
| Decorrelated jitter backoff | v1 | Spreads retries to a recovering endpoint; avoids thundering herd. |
| Consistent hashing | v2 | Pins an endpoint's events to a stable partition for ordered delivery. |
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
