import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const endpoints = sqliteTable("endpoints", {
  id: text("id").primaryKey(),                 // ep_<nanoid>
  url: text("url").notNull(),
  signingSecret: text("signing_secret").notNull(), // plaintext; generated at creation, shown once
  description: text("description"),
  ordered: integer("ordered", { mode: "boolean" }).notNull().default(false), // v2; unused in v1
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
});

export const deadLetters = sqliteTable("dead_letters", {
  eventId: text("event_id").primaryKey().references(() => events.id),
  failedAt: integer("failed_at", { mode: "timestamp_ms" })
    .notNull().default(sql`(unixepoch() * 1000)`),
  finalError: text("final_error"),
});

export type Endpoint = typeof endpoints.$inferSelect;
export type Event = typeof events.$inferSelect;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type DeadLetter = typeof deadLetters.$inferSelect;
