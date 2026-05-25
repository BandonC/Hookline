# CLAUDE.md — packages/api

The Cloudflare Worker: ingestion API (Hono), the reconciliation cron (`scheduled`
handler), and the per-endpoint Durable Object. The DO has its own deeper rules in
`src/do/CLAUDE.md` — read that before touching delivery logic.

Inherits all root rules. Scope-specific rules below.

## Runtime is Cloudflare Workers, not Node

- No Node-only APIs unless behind `nodejs_compat` and confirmed available. Prefer the
  Workers runtime built-ins: `fetch`, Web Crypto (`crypto.subtle`), `crypto.randomUUID()`,
  `AbortSignal.timeout()`.
- Bindings (`DB`, `ENDPOINT_DO`) come from the environment, typed in the `Bindings` type.
  Access them through the env, never via module-level globals.
- `wrangler.toml` is config, not code. Secrets never go in it — use `.dev.vars` locally
  and `wrangler secret put` for production. The `database_id` is not a secret and does
  belong there.

## Ingestion API (Hono)

- Routes: `POST /v1/events`, and `POST` / `GET` / `DELETE /v1/endpoints`.
- `POST /v1/events` flow, in order: validate body and target endpoint → generate
  `evt_<nanoid>` → write event to D1 as `pending` with a computed first `next_attempt_at`
  → poke the endpoint's DO to schedule it → return `202`. It must **not** await delivery.
- Creating an endpoint generates its HMAC signing secret server-side
  (`crypto.randomUUID()` or random bytes — not a guessable value) and stores it in D1.
  Return it to the caller once on creation; it is not retrievable in plaintext later if
  you choose to hash it (decide this explicitly, don't assume).
- Validate endpoint URLs. A user-supplied URL becomes a `fetch` target — flag and guard
  the SSRF surface (reject internal/loopback/metadata addresses) rather than blindly
  fetching whatever is registered.

## Reconciliation cron (`scheduled`)

- This is the at-least-once backstop, not the primary delivery path. It runs
  infrequently (see `wrangler.toml` crons).
- It queries D1 for `pending` events whose `next_attempt_at` is past due, and re-pokes the
  owning endpoint's DO. It does not deliver directly — delivery is always the DO's job, so
  there is one delivery code path.
- Keep it idempotent: re-poking a DO that already has the right alarm set must be a no-op.

## Durable Object wiring

- The `EndpointDO` class is exported from `src/index.ts` (Workers requires the class be
  exported from the entry module) and bound as `ENDPOINT_DO` in `wrangler.toml`.
- One DO instance per endpoint: address it with `idFromName(endpointId)`. Never share a DO
  across endpoints — that would break the v2 ordering model before it's even built.
- The DO is registered via a `new_sqlite_classes` migration in `wrangler.toml` (the
  free-tier SQLite-backed DO). Do not switch it to `new_classes` (the paid KV variant).

## What lives where

- HTTP handling, routing, validation, ingestion → this package's `src/index.ts` and route
  files.
- Scheduling, delivery, signing, backoff, dead-lettering → `src/do/`. See its CLAUDE.md.
- Schema and types → imported from `@hookline/db`. Don't redefine row shapes here.
