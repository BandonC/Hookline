import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, lte } from "drizzle-orm";
import { events as eventsTable } from "@hookline/db";
import type { Bindings } from "./bindings";
import { endpoints } from "./routes/endpoints";
import { events } from "./routes/events";
import { tenants } from "./routes/tenants";
import { computeShard, endpointDoName } from "./sharding";

// Per-run cap on the reconciliation scan. It's a backstop, not the primary path:
// anything past-due beyond this is swept by the next run (see crons in
// wrangler.toml), and re-poking is idempotent. Bounds D1 reads on the free tier.
const RECONCILE_LIMIT = 100;

// Workers requires the DO class be exported from the entry module.
export { EndpointDO } from "./do/endpoint-do";
export { SchedulerDO } from "./do/scheduler-do";

const app = new Hono<{ Bindings: Bindings }>();

app.route("/v1/endpoints", endpoints);
app.route("/v1/events", events);
app.route("/v1/tenants", tenants);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  // Log a bounded description, never the whole error object: a thrown error can
  // carry request/payload data on its properties, stack, or `cause`, and project
  // rules forbid logging payloads.
  console.error("unhandled error:", err instanceof Error ? `${err.name}: ${err.message}` : "non-Error thrown");
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
  // ordering_key is included so we can derive each row's owning sub-DO (Model
  // C: routing reads the event row alone, never the endpoint flag).
  const due = await db
    .select({
      id: eventsTable.id,
      endpointId: eventsTable.endpointId,
      orderingKey: eventsTable.orderingKey,
      nextAttemptAt: eventsTable.nextAttemptAt,
    })
    .from(eventsTable)
    .where(
      and(eq(eventsTable.status, "pending"), lte(eventsTable.nextAttemptAt, new Date(now))),
    )
    .orderBy(asc(eventsTable.nextAttemptAt))
    .limit(RECONCILE_LIMIT);

  // One poke per (endpoint, shard) — i.e. per DO. alarm() drains everything
  // that DO owns in a single run, so multiple pokes to the same DO would just
  // be redundant subrequests. Rows are ordered oldest-first, so the first row
  // seen for a given DO carries that DO's earliest due time. shard is null
  // for null-key events (bare DO) and a number for keyed events (sub-DO).
  type Poke = { eventId: string; endpointId: string; shard: number | null; dueAt: number };
  const byDo = new Map<string, Poke>();
  for (const row of due) {
    // next_attempt_at is non-null on these rows (the WHERE excludes NULLs); the
    // check also narrows Date | null -> Date for getTime().
    if (row.nextAttemptAt === null) continue;
    const shard = row.orderingKey === null ? null : await computeShard(row.orderingKey);
    const doName = endpointDoName(row.endpointId, shard);
    if (byDo.has(doName)) continue;
    byDo.set(doName, {
      eventId: row.id,
      endpointId: row.endpointId,
      shard,
      dueAt: row.nextAttemptAt.getTime(),
    });
  }

  // Re-poke with the EXACT shape ingestion uses (routes/events.ts). The DO arms
  // its alarm to the soonest due time and only ever moves it earlier, so poking
  // a DO whose alarm is already correct is a no-op — that's what makes this
  // backstop idempotent. Don't log payloads.
  const pokes = [...byDo].map(([doName, { eventId, endpointId, shard, dueAt }]) => {
    const stub = endpointDo.get(endpointDo.idFromName(doName));
    return stub
      .fetch("https://hookline.internal/poke", {
        method: "POST",
        body: JSON.stringify({ eventId, endpointId, dueAt, shard }),
      })
      .then((r) => {
        if (!r.ok) console.error("reconcile poke non-ok", doName, r.status);
      })
      .catch((err) => console.error("reconcile poke failed", doName, err));
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
