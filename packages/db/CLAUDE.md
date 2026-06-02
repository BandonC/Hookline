# CLAUDE.md — packages/db

The shared data layer: Drizzle schema, inferred types, migrations. Both the API Worker
and the dashboard import from here. This package has **no runtime dependencies of its
own** beyond `drizzle-orm` — keep it that way so the dashboard can import its types
without pulling in Worker code.

> **v2 has shipped.** This file is the v1 build record. For what exists now (the
> `tenants` table, `ordering_key`, the rate-limit and circuit-breaker columns, and
> the extra indexes) see `schema.ts` and HOOKLINE.md §7, and defer to the code where
> they differ.

Inherits all root rules. Scope-specific rules below.

## This package is the single source of truth for the data model

- `src/schema.ts` defines the tables. Everything else (migrations, types, queries
  elsewhere) derives from it. Change the schema here first, then regenerate.
- Export inferred types (`Endpoint`, `Event`, `DeliveryAttempt`) from `src/index.ts`.
  Consumers import these — they must never redefine the shape of a row by hand.

## Migrations

- Generate migrations with `drizzle-kit generate`. **Never hand-write or hand-edit the
  generated SQL** unless explicitly asked — if the schema needs to change, change
  `schema.ts` and regenerate.
- Migrations are applied via Wrangler from the `api` package (`wrangler d1 migrations
  apply`), not from here. This package only *defines* them.
- Don't squash or delete existing migration files. They're an applied history.

## Schema rules specific to Hookline

- `events.id` IS the idempotency key. It is generated at ingestion (`evt_<nanoid>`) and
  is what receivers dedupe on. Don't add a separate idempotency column.
- `events.status` is a strict enum: `pending` / `delivered` / `failed`. No other values.
- `events.attempt_count` and `events.next_attempt_at` drive the Durable Object's
  scheduling. `next_attempt_at` is nullable (null = not currently scheduled).
- `endpoints.ordered` defaults to `false` and opts an endpoint into ordered delivery.
  v1 didn't branch on it; v2 does — same-key events route to a sub-DO via consistent
  hashing. It was present from v1 so enabling v2 ordering needed no migration.
- There is an index on `(status, next_attempt_at)` because the reconciliation cron queries
  pending events by due time. If you change how the cron queries, reconsider the index —
  don't leave an unused index or query an unindexed path.
- `delivery_attempts.response_snippet` is capped at 1KB. The cap is enforced in the
  delivery code (the DO), not here, but the column exists to hold a *bounded* snippet —
  document that expectation if you touch it.

## Types over guesses

- When the API or dashboard needs a row shape, it imports the inferred type. If you find
  yourself writing an `interface Event { ... }` outside this package, stop — import it.
