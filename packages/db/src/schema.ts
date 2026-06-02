import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// v2 fair scheduling: the unit of fairness. Endpoints belong to exactly one
// tenant; events inherit their tenant via endpoint join. `weight` drives DRR
// credit accrual in the coordinator DO; `max_in_flight` is an optional per-
// tenant override of the code default. Default tenant row (`ten_default`)
// is inserted by the migration to satisfy the non-null FK on existing rows.
export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),                 // ten_<nanoid>
  name: text("name").notNull(),
  weight: integer("weight").notNull().default(1),
  maxInFlight: integer("max_in_flight"),       // null = use code default
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull().default(sql`(unixepoch() * 1000)`),
});

export const DEFAULT_TENANT_ID = "ten_default";

export const endpoints = sqliteTable("endpoints", {
  id: text("id").primaryKey(),                 // ep_<nanoid>
  // v2 fair scheduling: every endpoint belongs to a tenant. Non-null with a
  // DB-level default of `ten_default` so the SQLite ALTER TABLE ADD COLUMN
  // can succeed against pre-migration rows; new endpoints always supply
  // tenant_id explicitly at the POST /v1/endpoints route, so the default
  // never fires in steady-state.
  tenantId: text("tenant_id").notNull().default(DEFAULT_TENANT_ID)
    .references(() => tenants.id),
  url: text("url").notNull(),
  signingSecret: text("signing_secret").notNull(), // plaintext; generated at creation, shown once
  description: text("description"),
  ordered: integer("ordered", { mode: "boolean" }).notNull().default(false), // v2; unused in v1
  // v2 per-endpoint rate limiting. Both nullable; either NULL = unlimited.
  // Validation: both must be set together or both NULL (enforced at the PATCH
  // route, not the DB — keeps the schema permissive for ingestion of older
  // rows and future config shapes).
  rateLimitRps: integer("rate_limit_rps"),
  rateLimitBurst: integer("rate_limit_burst"),
  // v2 circuit breaker. `circuit_breaker_enabled` is the operator intent flag.
  // The two tunables are nullable (null = use code default); validation lives
  // at the PATCH route. The three runtime-state columns are managed by the DO
  // via CAS — see packages/api/src/do/endpoint-do.ts. PATCH resets the runtime
  // state whenever `circuit_breaker_enabled` is in the body, so toggling the
  // flag never leaves stale state behind.
  circuitBreakerEnabled: integer("circuit_breaker_enabled", { mode: "boolean" })
    .notNull().default(false),
  breakerOpenSec: integer("breaker_open_sec"),
  breakerThresholdPct: integer("breaker_threshold_pct"),
  breakerState: text("breaker_state", { enum: ["closed", "open", "half_open"] })
    .notNull().default("closed"),
  breakerOpenedAt: integer("breaker_opened_at", { mode: "timestamp_ms" }),
  breakerOpenUntil: integer("breaker_open_until", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull().default(sql`(unixepoch() * 1000)`),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),                 // evt_<nanoid> — IS the idempotency key
  endpointId: text("endpoint_id").notNull().references(() => endpoints.id),
  payload: text("payload", { mode: "json" }).notNull(),
  status: text("status", { enum: ["pending", "delivered", "failed"] })
    .notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }), // null = not scheduled
  lastDelayMs: integer("last_delay_ms"), // prev decorrelated-jitter delay; null until first retry computed
  // v2 ordered delivery: nullable. Required-when-ordered is enforced at the
  // ingestion API, not the DB, so flipping endpoints.ordered later doesn't
  // retroactively invalidate historical rows.
  orderingKey: text("ordering_key"),
  // v2 rate limiting: when the DO declines to deliver this tick (e.g. token
  // bucket dry), record WHY. Cleared in every deliver() batch so it always
  // reflects the most recent scheduling decision. Enum widens for v2's
  // circuit breaker + fair scheduling later.
  lastDeferReason: text("last_defer_reason", { enum: ["rate_limited", "breaker_open", "tenant_throttled"] }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  pendingDueIdx: index("pending_due_idx").on(t.status, t.nextAttemptAt),
  // Per-key head query for ordered delivery: for a given (endpoint, key),
  // find the oldest pending event by created_at. Sub-DO alarm() reads from
  // this index; head waits on its own next_attempt_at without skipping.
  orderedHeadIdx: index("ordered_head_idx").on(
    t.endpointId, t.orderingKey, t.status, t.createdAt,
  ),
}));

export const deliveryAttempts = sqliteTable("delivery_attempts", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => events.id),
  attemptNumber: integer("attempt_number").notNull(),
  statusCode: integer("status_code"),            // null on network error
  responseSnippet: text("response_snippet"),     // capped 1KB in the DO, never read-then-slice
  latencyMs: integer("latency_ms"),
  attemptedAt: integer("attempted_at", { mode: "timestamp_ms" })
    .notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  // v2 rate-limit bucket replay: per alarm tick the DO joins attempts back
  // to events filtered by endpoint (+shard) and time window. Composite
  // covers both the FK join (leading column) and the recent-time filter.
  // See packages/api/src/rate-limit.ts.
  attemptByEventTimeIdx: index("attempt_by_event_time_idx").on(t.eventId, t.attemptedAt),
}));

export const deadLetters = sqliteTable("dead_letters", {
  eventId: text("event_id").primaryKey().references(() => events.id),
  failedAt: integer("failed_at", { mode: "timestamp_ms" })
    .notNull().default(sql`(unixepoch() * 1000)`),
  finalError: text("final_error"),
});

export type Tenant = typeof tenants.$inferSelect;
export type Endpoint = typeof endpoints.$inferSelect;
export type Event = typeof events.$inferSelect;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type DeadLetter = typeof deadLetters.$inferSelect;
