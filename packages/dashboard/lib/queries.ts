import { asc, count, desc, eq } from "drizzle-orm";
import { endpoints, events, deliveryAttempts, deadLetters } from "@hookline/db";
import { getDb } from "./db";

// signing_secret is NEVER selected in this file. Endpoint reads use an explicit
// column list (publicEndpointColumns) so the credential is not even loaded into
// memory, let alone serialized into a page. See packages/dashboard/CLAUDE.md.
const publicEndpointColumns = {
  id: endpoints.id,
  url: endpoints.url,
  description: endpoints.description,
  ordered: endpoints.ordered,
  createdAt: endpoints.createdAt,
} as const;

export async function listEndpoints() {
  const db = getDb();
  const [rows, pending] = await Promise.all([
    db.select(publicEndpointColumns).from(endpoints).orderBy(desc(endpoints.createdAt)),
    db
      .select({ endpointId: events.endpointId, n: count() })
      .from(events)
      .where(eq(events.status, "pending"))
      .groupBy(events.endpointId),
  ]);
  const pendingByEndpoint = new Map(pending.map((p) => [p.endpointId, p.n]));
  return rows.map((e) => ({ ...e, pending: pendingByEndpoint.get(e.id) ?? 0 }));
}

export async function recentEvents(limit = 50) {
  const db = getDb();
  return db
    .select({
      id: events.id,
      endpointId: events.endpointId,
      status: events.status,
      attemptCount: events.attemptCount,
      nextAttemptAt: events.nextAttemptAt,
      createdAt: events.createdAt,
    })
    .from(events)
    .orderBy(desc(events.createdAt))
    .limit(limit);
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

  return { event, attempts };
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
    })
    .from(deadLetters)
    .innerJoin(events, eq(events.id, deadLetters.eventId))
    .orderBy(desc(deadLetters.failedAt));
}
