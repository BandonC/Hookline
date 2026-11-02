import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { endpoints, events, deliveryAttempts, deadLetters } from "@hookline/db";
import type { DeliveryAttempt } from "@hookline/db";
import { getDb } from "./db";

// signing_secret is NEVER selected in this file. Endpoint reads use an explicit
// column list (publicEndpointColumns) so the credential is not even loaded into
// memory, let alone serialized into a page. See packages/dashboard/CLAUDE.md.
const publicEndpointColumns = {
  id: endpoints.id,
  tenantId: endpoints.tenantId,
  url: endpoints.url,
  description: endpoints.description,
  ordered: endpoints.ordered,
  rateLimitRps: endpoints.rateLimitRps,
  rateLimitBurst: endpoints.rateLimitBurst,
  circuitBreakerEnabled: endpoints.circuitBreakerEnabled,
  breakerState: endpoints.breakerState,
  breakerOpenUntil: endpoints.breakerOpenUntil,
  createdAt: endpoints.createdAt,
} as const;

export async function listEndpoints() {
  const db = getDb();
  const [rows, tallies] = await Promise.all([
    db.select(publicEndpointColumns).from(endpoints).orderBy(desc(endpoints.createdAt)),
    db
      .select({ endpointId: events.endpointId, status: events.status, n: count() })
      .from(events)
      .groupBy(events.endpointId, events.status),
  ]);
  const tally = (id: string, status: "pending" | "delivered" | "failed") =>
    tallies.find((t) => t.endpointId === id && t.status === status)?.n ?? 0;
  return rows.map((e) => ({
    ...e,
    pending: tally(e.id, "pending"),
    delivered: tally(e.id, "delivered"),
    failed: tally(e.id, "failed"),
  }));
}

// tenant_id is on endpoints, not events — join to surface it per-row so the
// deliveries list shows which tenant owns each event without a second query.
//
// attemptsMade comes from delivery_attempts, not events.attempt_count: deliver()
// doesn't write attempt_count on success, so it undercounts delivered events by
// one (a first-try delivery reads 0).
export async function recentEvents(limit = 50) {
  const db = getDb();
  const rows = await db
    .select({
      id: events.id,
      endpointId: events.endpointId,
      tenantId: endpoints.tenantId,
      status: events.status,
      nextAttemptAt: events.nextAttemptAt,
      lastDeferReason: events.lastDeferReason,
      orderingKey: events.orderingKey,
      createdAt: events.createdAt,
    })
    .from(events)
    .innerJoin(endpoints, eq(events.endpointId, endpoints.id))
    .orderBy(desc(events.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const made = await db
    .select({ eventId: deliveryAttempts.eventId, n: max(deliveryAttempts.attemptNumber) })
    .from(deliveryAttempts)
    .where(
      inArray(
        deliveryAttempts.eventId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(deliveryAttempts.eventId);
  const madeByEvent = new Map(made.map((m) => [m.eventId, m.n ?? 0]));
  return rows.map((r) => ({ ...r, attemptsMade: madeByEvent.get(r.id) ?? 0 }));
}

// Every waiting event, oldest-due first, for the Overview's "why is it waiting"
// breakdown. Served by pending_due_idx. Capped so a large backlog can't turn a
// page view (and its auto-refresh) into a big D1 read; past the cap the
// breakdown covers the 500 most overdue, and the total still comes from
// eventCounts().
export async function pendingEvents() {
  const db = getDb();
  const rows = await db
    .select({
      nextAttemptAt: events.nextAttemptAt,
      lastDeferReason: events.lastDeferReason,
      orderingKey: events.orderingKey,
      attemptCount: events.attemptCount,
    })
    .from(events)
    .where(eq(events.status, "pending"))
    .orderBy(asc(events.nextAttemptAt))
    .limit(500);
  // Pending events have only failed attempts, so attempt_count is accurate here.
  return rows.map(({ attemptCount, ...r }) => ({ ...r, attemptsMade: attemptCount }));
}

export async function latestDeadLetterAt() {
  const db = getDb();
  const [row] = await db
    .select({ failedAt: deadLetters.failedAt })
    .from(deadLetters)
    .orderBy(desc(deadLetters.failedAt))
    .limit(1);
  return row?.failedAt ?? null;
}

// With no status code the receiver never answered, so deliver() stored its own
// error name (e.g. TimeoutError), not receiver data. The shape check is an
// allowlist on purpose: if deliver() ever stores something richer, such as
// err.message with a hostname in it, that falls back to redacted instead of
// going public.
function redactSnippet(a: Pick<DeliveryAttempt, "statusCode" | "responseSnippet">) {
  if (a.responseSnippet === null) return null;
  const isErrorName =
    a.statusCode === null &&
    (/^[A-Za-z]*Error$/.test(a.responseSnippet) || a.responseSnippet === "fetch failed");
  return isErrorName ? a.responseSnippet : "[redacted]";
}

export async function eventWithAttempts(id: string) {
  const db = getDb();
  const [event] = await db
    .select({
      id: events.id,
      endpointId: events.endpointId,
      status: events.status,
      attemptCount: events.attemptCount,
      nextAttemptAt: events.nextAttemptAt,
      orderingKey: events.orderingKey,
      lastDeferReason: events.lastDeferReason,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  if (!event) return null;

  const attempts = await db
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.eventId, id))
    .orderBy(asc(deliveryAttempts.attemptNumber));

  // A response_snippet is the receiver's response body (capped 1KB) and can
  // carry sensitive data, so public-demo mode (no Basic Auth gate) redacts it;
  // gated deployments still show it. See redactSnippet for the one exception.
  const publicMode = getCloudflareContext().env.DASHBOARD_PUBLIC === "true";
  const safeAttempts = publicMode
    ? attempts.map((a) => ({ ...a, responseSnippet: redactSnippet(a) }))
    : attempts;

  // For pending ordered events, surface "this isn't the head of its
  // (endpoint, key) queue" so it's clear when waiting is per-key HOLB and
  // not just a scheduled retry. Served by ordered_head_idx
  // (endpoint_id, ordering_key, status, created_at).
  let blockedBy: { id: string } | null = null;
  if (event.orderingKey !== null && event.status === "pending") {
    const [head] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.endpointId, event.endpointId),
          eq(events.orderingKey, event.orderingKey),
          eq(events.status, "pending"),
        ),
      )
      .orderBy(asc(events.createdAt))
      .limit(1);
    if (head && head.id !== event.id) blockedBy = { id: head.id };
  }

  const [deadLetter] = await db
    .select({ failedAt: deadLetters.failedAt, finalError: deadLetters.finalError })
    .from(deadLetters)
    .where(eq(deadLetters.eventId, id))
    .limit(1);

  return { event, attempts: safeAttempts, blockedBy, deadLetter: deadLetter ?? null };
}

export async function eventCounts() {
  const db = getDb();
  const rows = await db
    .select({ status: events.status, n: count() })
    .from(events)
    .groupBy(events.status);
  const by = { pending: 0, delivered: 0, failed: 0 };
  for (const r of rows) by[r.status] = r.n;
  return { ...by, total: by.pending + by.delivered + by.failed };
}

export async function listDeadLetters() {
  const db = getDb();
  return db
    .select({
      eventId: deadLetters.eventId,
      failedAt: deadLetters.failedAt,
      finalError: deadLetters.finalError,
      endpointId: events.endpointId,
      endpointDescription: endpoints.description,
      attemptsMade: events.attemptCount,
      createdAt: events.createdAt,
    })
    .from(deadLetters)
    .innerJoin(events, eq(events.id, deadLetters.eventId))
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .orderBy(desc(deadLetters.failedAt));
}
