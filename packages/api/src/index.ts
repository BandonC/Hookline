import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "./bindings";
import { endpoints } from "./routes/endpoints";
import { events } from "./routes/events";

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

export default {
  fetch: app.fetch,

  // Reconciliation backstop (at-least-once). Low frequency. NOT primary delivery.
  // Finds past-due `pending` events, re-pokes each owning endpoint's DO. Idempotent.
  async scheduled(_event: ScheduledController, env: Bindings): Promise<void> {
    const _db = drizzle(env.DB);
    // TODO (Step 5): SELECT past-due pending events -> for each, get the
    //   endpoint's DO via env.ENDPOINT_DO.get(idFromName(endpointId)).fetch(...)
  },
};
