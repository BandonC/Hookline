import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, lte } from "drizzle-orm";
import { events as eventsTable } from "@hookline/db";
import type { Bindings } from "./bindings";
import { endpoints } from "./routes/endpoints";
import { events } from "./routes/events";

// Per-run cap on the reconciliation scan. It's a backstop, not the primary path:
// anything past-due beyond this is swept by the next run (see crons in
// wrangler.toml), and re-poking is idempotent. Bounds D1 reads on the free tier.
const RECONCILE_LIMIT = 100;

// Workers requires the DO class be exported from the entry module.
export { EndpointDO } from "./do/endpoint-do";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/v1/endpoints", endpoints);
app.route("/v1/events", events);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Reconciliation backstop (project invariant 1: at-least-once, never a silent
// drop). Runs on the cron in wrangler.toml. Finds past-due `pending` events and
// re-pokes each owning endpoint's DO so a lost ingestion poke still results in
// delivery. It NEVER delivers directly — delivery is always the DO's job, so
// there is exactly one delivery code path. Exported for direct unit testing.
export async function reconcile(
  db: ReturnType<typeof drizzle>,
  endpointDo: DurableObjectNamespace,
): Promise<void> {
  const now = Date.now();

  // Served by pending_due_idx on (status, next_attempt_at): equality on status,
  // range + ordering on next_attempt_at. Oldest-due first, capped per run.
  const due = await db
    .select({
      id: eventsTable.id,
      endpointId: eventsTable.endpointId,
      nextAttemptAt: eventsTable.nextAttemptAt,
    })
    .from(eventsTable)
    .where(
      and(eq(eventsTable.status, "pending"), lte(eventsTable.nextAttemptAt, new Date(now))),
    )
    .orderBy(asc(eventsTable.nextAttemptAt))
    .limit(RECONCILE_LIMIT);

  // One poke per endpoint: alarm() drains ALL of an endpoint's due events in a
  // single run, so a poke per event would just be redundant subrequests. Rows
  // are ordered oldest-first, so the first row seen for an endpoint carries its
  // earliest due time.
  const byEndpoint = new Map<string, { eventId: string; dueAt: number }>();
  for (const row of due) {
    // next_attempt_at is non-null on these rows (the WHERE excludes NULLs); the
    // check also narrows Date | null -> Date for getTime().
    if (row.nextAttemptAt === null || byEndpoint.has(row.endpointId)) continue;
    byEndpoint.set(row.endpointId, { eventId: row.id, dueAt: row.nextAttemptAt.getTime() });
  }

  // Re-poke with the EXACT shape ingestion uses (routes/events.ts). The DO arms
  // its alarm to the soonest due time and only ever moves it earlier, so poking
  // a DO whose alarm is already correct is a no-op — that's what makes this
  // backstop idempotent. Don't log payloads.
  const pokes = [...byEndpoint].map(([endpointId, { eventId, dueAt }]) => {
    const stub = endpointDo.get(endpointDo.idFromName(endpointId));
    return stub
      .fetch("https://hookline.internal/poke", {
        method: "POST",
        body: JSON.stringify({ eventId, endpointId, dueAt }),
      })
      .then((r) => {
        if (!r.ok) console.error("reconcile poke non-ok", endpointId, r.status);
      })
      .catch((err) => console.error("reconcile poke failed", endpointId, err));
  });

  await Promise.all(pokes);
}

export default {
  fetch: app.fetch,

  // Reconciliation backstop (at-least-once). Low frequency. NOT primary delivery.
  async scheduled(_event: ScheduledController, env: Bindings): Promise<void> {
    await reconcile(drizzle(env.DB), env.ENDPOINT_DO);
  },
};
