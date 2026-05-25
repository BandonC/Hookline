import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";

// Workers requires the DO class be exported from the entry module.
export { EndpointDO } from "./do/endpoint-do";

type Bindings = { DB: D1Database; ENDPOINT_DO: DurableObjectNamespace };

const app = new Hono<{ Bindings: Bindings }>();

// ── Endpoint CRUD ──
// Creating an endpoint generates a plaintext signing secret server-side and
// returns it ONCE in the create response. It is stored plaintext in D1 and is
// not surfaced again. Validate + SSRF-guard endpoint URLs.
app.post("/v1/endpoints", (c) => c.json({ todo: "create endpoint + gen secret, return once" }, 501));
app.get("/v1/endpoints", (c) => c.json({ todo: "list endpoints (never return signing_secret)" }, 501));
app.delete("/v1/endpoints/:id", (c) => c.json({ todo: "delete endpoint" }, 501));

// ── Event ingestion ──
// validate -> evt_<nanoid> -> write D1 pending (+ first next_attempt_at)
// -> poke endpoint DO -> 202. MUST NOT await delivery.
app.post("/v1/events", (c) => c.json({ todo: "persist pending, poke DO, return 202" }, 501));

export default {
  fetch: app.fetch,

  // Reconciliation backstop (at-least-once). Low frequency. NOT primary delivery.
  // Finds past-due `pending` events, re-pokes each owning endpoint's DO. Idempotent.
  async scheduled(_event: ScheduledController, env: Bindings): Promise<void> {
    const _db = drizzle(env.DB);
    // TODO: SELECT past-due pending events -> for each, get the endpoint's DO via
    //   env.ENDPOINT_DO.get(env.ENDPOINT_DO.idFromName(endpointId)).fetch(...)
  },
};
